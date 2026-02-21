/**
 * AWS EventBridge Webhook — Receives AWS change events
 *
 * Handles CodePipeline, ECS, and Lambda state change events.
 */

import type { FastifyInstance } from 'fastify';
import type { ChangeEventStore } from '../../store';
import { internalError } from '../../errors';

type ParsedEvent = Parameters<ChangeEventStore['insert']>[0];

export async function awsWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/v1/webhooks/aws', async (request, reply) => {
    const payload = request.body as Record<string, unknown>;
    const detailType = payload['detail-type'] as string;
    const detail = payload.detail as Record<string, unknown> || {};

    try {
      const event = parseAWSEvent(detailType, detail, payload);
      if (event) {
        const stored = fastify.store.insert(event);
        fastify.webhookDispatcher.dispatch(stored, fastify.log);
        return reply.status(201).send({ id: stored.id, message: 'Event ingested' });
      }
      return reply.send({ message: `Ignored event type: ${detailType}` });
    } catch (error) {
      fastify.log.error(error, 'Failed to process AWS webhook');
      return internalError(reply, 'Failed to process AWS webhook');
    }
  });
}

function parseAWSEvent(
  detailType: string,
  detail: Record<string, unknown>,
  envelope: Record<string, unknown>
): ParsedEvent | null {
  switch (detailType) {
    case 'CodePipeline Pipeline Execution State Change':
      return parseCodePipelineEvent(detail, envelope);
    case 'ECS Task State Change':
    case 'ECS Deployment State Change':
      return parseECSEvent(detailType, detail, envelope);
    case 'AWS API Call via CloudTrail':
      return parseCloudTrailEvent(detail, envelope);
    default:
      return null;
  }
}

function parseCodePipelineEvent(
  detail: Record<string, unknown>,
  envelope: Record<string, unknown>
): ParsedEvent {
  const pipeline = detail.pipeline as string || 'unknown';
  const state = detail.state as string;

  return {
    service: pipeline,
    changeType: 'deployment',
    source: 'aws_codepipeline',
    initiator: 'automation',
    status: mapPipelineState(state),
    environment: 'production',
    summary: `CodePipeline ${pipeline}: ${state}`,
    metadata: {
      aws_event: detailTypeFrom(envelope),
      pipeline,
      execution_id: detail['execution-id'],
      region: envelope.region,
    },
  };
}

function parseECSEvent(
  detailType: string,
  detail: Record<string, unknown>,
  envelope: Record<string, unknown>
): ParsedEvent {
  const clusterArn = detail.clusterArn as string || '';
  const group = detail.group as string || '';
  const serviceName = extractServiceNameFromArn(clusterArn) || group.replace('service:', '') || 'unknown';

  const status = detailType === 'ECS Deployment State Change'
    ? mapECSDeploymentStatus(detail)
    : 'in_progress';

  return {
    service: serviceName,
    changeType: 'deployment',
    source: 'aws_ecs',
    initiator: 'automation',
    status,
    environment: 'production',
    summary: `ECS ${detailType}: ${serviceName}`,
    metadata: {
      aws_event: detailTypeFrom(envelope),
      cluster: clusterArn,
      region: envelope.region,
    },
  };
}

function parseCloudTrailEvent(
  detail: Record<string, unknown>,
  envelope: Record<string, unknown>
): ParsedEvent | null {
  const eventName = detail.eventName as string;
  const eventSource = detail.eventSource as string;

  // Only handle Lambda function updates
  if (eventSource === 'lambda.amazonaws.com' && eventName === 'UpdateFunctionCode20150331v2') {
    const requestParams = detail.requestParameters as Record<string, unknown> || {};
    const functionName = requestParams.functionName as string || 'unknown';

    return {
      service: functionName,
      changeType: 'deployment',
      source: 'aws_lambda',
      initiator: 'automation',
      status: 'completed',
      environment: 'production',
      summary: `Lambda function updated: ${functionName}`,
      metadata: {
        aws_event: detailTypeFrom(envelope),
        event_name: eventName,
        region: envelope.region,
      },
    };
  }

  return null;
}

function mapPipelineState(state: string): string {
  switch (state) {
    case 'SUCCEEDED': return 'completed';
    case 'FAILED': return 'failed';
    case 'CANCELED': case 'SUPERSEDED': return 'rolled_back';
    default: return 'in_progress';
  }
}

function mapECSDeploymentStatus(detail: Record<string, unknown>): string {
  const eventName = detail.eventName as string || '';
  if (eventName.includes('COMPLETED')) return 'completed';
  if (eventName.includes('FAILED')) return 'failed';
  return 'in_progress';
}

function extractServiceNameFromArn(arn: string): string | null {
  const parts = arn.split('/');
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

function detailTypeFrom(envelope: Record<string, unknown>): string {
  return envelope['detail-type'] as string || 'unknown';
}
