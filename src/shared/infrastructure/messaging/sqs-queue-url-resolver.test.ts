import { describe, expect, it } from 'bun:test';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SqsQueueUrlResolver } from './sqs-queue-url-resolver';

function fakeClient(handler: (command: unknown) => unknown): SQSClient {
  return { send: async (command: unknown) => handler(command) } as unknown as SQSClient;
}

describe('SqsQueueUrlResolver', () => {
  it('resolves the queue URL returned by GetQueueUrlCommand for the given name', async () => {
    let receivedQueueName: string | undefined;
    const client = fakeClient((command) => {
      const input = (command as GetQueueUrlCommand).input;
      receivedQueueName = input.QueueName;
      return { QueueUrl: 'http://localhost:4566/000000000000/some-queue.fifo' };
    });

    const resolver = new SqsQueueUrlResolver(client);
    const url = await resolver.resolve('some-queue.fifo');

    expect(url).toBe('http://localhost:4566/000000000000/some-queue.fifo');
    expect(receivedQueueName).toBe('some-queue.fifo');
  });

  it('throws if GetQueueUrlCommand does not return a QueueUrl', async () => {
    const client = fakeClient(() => ({})); // no QueueUrl in the response

    const resolver = new SqsQueueUrlResolver(client);

    await expect(resolver.resolve('missing-queue.fifo')).rejects.toThrow(
      'GetQueueUrlCommand for "missing-queue.fifo" did not return a QueueUrl.',
    );
  });

  it('propagates a failure from the SQS client (e.g. queue does not exist) — never swallows it', async () => {
    const client = fakeClient(() => {
      throw new Error('QueueDoesNotExist');
    });

    const resolver = new SqsQueueUrlResolver(client);

    await expect(resolver.resolve('does-not-exist.fifo')).rejects.toThrow('QueueDoesNotExist');
  });
});
