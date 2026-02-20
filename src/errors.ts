/**
 * Structured Error Responses — Agent-friendly error helpers
 *
 * All errors return a consistent shape with machine-readable codes,
 * human-readable messages, and recovery hints for AI agents.
 */

import type { FastifyReply } from 'fastify';

export interface StructuredError {
  error: string;
  message: string;
  hint: string;
  status: number;
  details?: unknown;
}

export function sendError(
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
  hint: string,
  details?: unknown,
): FastifyReply {
  const body: StructuredError = { error, message, hint, status };
  if (details !== undefined) body.details = details;
  return reply.status(status).send(body);
}

export function validationError(reply: FastifyReply, details: unknown): FastifyReply {
  return sendError(
    reply,
    400,
    'validation_error',
    'Request body failed validation.',
    'Check the details array for specific field errors and correct the request.',
    details,
  );
}

export function notFoundError(reply: FastifyReply, resource: string, id: string): FastifyReply {
  return sendError(
    reply,
    404,
    'not_found',
    `${resource} '${id}' not found.`,
    `Verify the ${resource.toLowerCase()} ID is correct. Use the list endpoint to find valid IDs.`,
  );
}

export function unauthorizedError(reply: FastifyReply, reason: string): FastifyReply {
  return sendError(
    reply,
    401,
    'unauthorized',
    reason,
    'Provide a valid authentication token in the Authorization header or webhook signature.',
  );
}

export function internalError(reply: FastifyReply, message: string): FastifyReply {
  return sendError(
    reply,
    500,
    'internal_error',
    message,
    'Retry the request. If the error persists, check service logs.',
  );
}

export function badGatewayError(reply: FastifyReply, upstream: string, details?: unknown): FastifyReply {
  return sendError(
    reply,
    502,
    'bad_gateway',
    `Upstream service '${upstream}' returned an error.`,
    `Check that ${upstream} is reachable and configured correctly.`,
    details,
  );
}

export function notImplementedError(reply: FastifyReply, feature: string, alternative: string): FastifyReply {
  return sendError(
    reply,
    501,
    'not_implemented',
    `${feature} is not yet implemented.`,
    alternative,
  );
}
