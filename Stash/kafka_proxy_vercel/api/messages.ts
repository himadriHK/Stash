import { getConfluentGateway } from '../src/kafka.ts';
import { createMessagesHandler } from '../src/messages.ts';

/**
 * POST /api/messages  produce one record
 * GET  /api/messages  poll the device's upload-response consumer group
 */
export default createMessagesHandler({ gateway: getConfluentGateway });
