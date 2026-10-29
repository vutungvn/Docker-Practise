import type { Request, Response } from 'express';
import { loadConfig } from '../../src/config';
import { faultInjection } from '../../src/fault';

function run(mode: Parameters<typeof faultInjection>[0], random: () => number) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
  const next = jest.fn();
  faultInjection(mode, random)({} as Request, res, next);
  return { res, next };
}

describe('faultInjection (demo of the automatic rollback)', () => {
  it('does nothing when off', () => {
    const { res, next } = run('none', () => 0);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('errors mode fails about 30 % of requests with HTTP 500', () => {
    expect(run('errors', () => 0.1).res.status).toHaveBeenCalledWith(500);
    expect(run('errors', () => 0.9).next).toHaveBeenCalled();
  });

  it('latency mode delays the request', () => {
    jest.useFakeTimers();
    const { next } = run('latency', () => 0);
    expect(next).not.toHaveBeenCalled();
    jest.advanceTimersByTime(800);
    expect(next).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('config rejects an unknown fault mode and defaults to none', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', FAULT_MODE: 'meteor' })).toThrow('Unknown FAULT_MODE');
    expect(loadConfig({ DATABASE_URL: 'x', STARTUP_DELAY_SECONDS: '3' })).toMatchObject({
      fault: 'none',
      startupDelayMs: 3000,
    });
  });
});
