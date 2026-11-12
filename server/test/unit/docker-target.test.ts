import { describe, expect, it } from 'vitest';
import { dockerodeOptions } from '../../src/docker/client.js';

describe('dockerodeOptions', () => {
  it('treats a path as a unix socket', () => {
    expect(dockerodeOptions('/var/run/docker.sock')).toEqual({ socketPath: '/var/run/docker.sock' });
  });
  it('parses tcp://host:port for socket proxies', () => {
    expect(dockerodeOptions('tcp://socket-proxy:2375')).toEqual({
      host: 'socket-proxy',
      port: 2375,
      protocol: 'http',
    });
  });
});
