import { describe, it, expect } from 'vitest';
import {
  sendError,
  validationError,
  notFoundError,
  unauthorizedError,
  internalError,
  badGatewayError,
  notImplementedError,
} from '../errors';

function createMockReply() {
  let statusCode = 200;
  let body: unknown;
  const reply = {
    status(code: number) {
      statusCode = code;
      return reply;
    },
    send(data: unknown) {
      body = data;
      return reply;
    },
    getStatus: () => statusCode,
    getBody: () => body,
  };
  return reply;
}

describe('Structured Error Helpers', () => {
  it('sendError returns the correct shape', () => {
    const reply = createMockReply();
    sendError(reply as any, 418, 'teapot', 'I am a teapot', 'Use a coffee pot instead');
    expect(reply.getStatus()).toBe(418);
    const body = reply.getBody() as any;
    expect(body.error).toBe('teapot');
    expect(body.message).toBe('I am a teapot');
    expect(body.hint).toBe('Use a coffee pot instead');
    expect(body.status).toBe(418);
    expect(body.details).toBeUndefined();
  });

  it('sendError includes details when provided', () => {
    const reply = createMockReply();
    sendError(reply as any, 400, 'bad', 'Bad', 'Fix it', { field: 'name' });
    const body = reply.getBody() as any;
    expect(body.details).toEqual({ field: 'name' });
  });

  it('validationError returns 400 with validation_error code', () => {
    const reply = createMockReply();
    const issues = [{ path: ['name'], message: 'Required' }];
    validationError(reply as any, issues);
    expect(reply.getStatus()).toBe(400);
    const body = reply.getBody() as any;
    expect(body.error).toBe('validation_error');
    expect(body.details).toEqual(issues);
    expect(body.hint).toBeDefined();
  });

  it('notFoundError returns 404 with not_found code', () => {
    const reply = createMockReply();
    notFoundError(reply as any, 'Event', 'abc-123');
    expect(reply.getStatus()).toBe(404);
    const body = reply.getBody() as any;
    expect(body.error).toBe('not_found');
    expect(body.message).toContain('Event');
    expect(body.message).toContain('abc-123');
  });

  it('unauthorizedError returns 401 with unauthorized code', () => {
    const reply = createMockReply();
    unauthorizedError(reply as any, 'Invalid token');
    expect(reply.getStatus()).toBe(401);
    const body = reply.getBody() as any;
    expect(body.error).toBe('unauthorized');
    expect(body.message).toBe('Invalid token');
  });

  it('internalError returns 500 with internal_error code', () => {
    const reply = createMockReply();
    internalError(reply as any, 'Something broke');
    expect(reply.getStatus()).toBe(500);
    const body = reply.getBody() as any;
    expect(body.error).toBe('internal_error');
    expect(body.message).toBe('Something broke');
  });

  it('badGatewayError returns 502 with bad_gateway code', () => {
    const reply = createMockReply();
    badGatewayError(reply as any, 'Backstage', 'Connection refused');
    expect(reply.getStatus()).toBe(502);
    const body = reply.getBody() as any;
    expect(body.error).toBe('bad_gateway');
    expect(body.message).toContain('Backstage');
    expect(body.details).toBe('Connection refused');
  });

  it('notImplementedError returns 501 with not_implemented code', () => {
    const reply = createMockReply();
    notImplementedError(reply as any, 'Auto-discovery', 'Use import instead.');
    expect(reply.getStatus()).toBe(501);
    const body = reply.getBody() as any;
    expect(body.error).toBe('not_implemented');
    expect(body.message).toContain('Auto-discovery');
    expect(body.hint).toBe('Use import instead.');
  });
});
