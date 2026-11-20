/** Liveness route. Deliberately does not touch Kafka or load the native client. */
import { HttpError, errorResponse, jsonResponse, methodNotAllowed } from './http.ts';

export function createHealthHandler() {
  return {
    fetch(request: Request): Response {
      try {
        if (request.method !== 'GET') {
          throw methodNotAllowed(['GET']);
        }
        return jsonResponse(
          {
            status: 'ok',
            service: 'stash-kafka-proxy-vercel',
            time: new Date().toISOString(),
          },
          200,
        );
      } catch (error) {
        const httpError =
          error instanceof HttpError
            ? error
            : new HttpError(500, 'internal_error', 'Unexpected proxy error.');
        return errorResponse(httpError.status, httpError.code, httpError.message);
      }
    },
  };
}
