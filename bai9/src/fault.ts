import type { RequestHandler } from 'express';
import type { FaultMode } from './config';

/**
 * Demo-only fault injection, used to prove the automatic rollback (README, scenario 3).
 * Off unless FAULT_MODE is set on a deployment; the pipeline only sets it when a person runs the
 * workflow manually with the "inject_fault" input. It simulates a bad release that passes every test:
 *   errors  -> 30 % of catalog requests fail with HTTP 500
 *   latency -> catalog requests take an extra 800 ms
 */
export function faultInjection(mode: FaultMode, random: () => number = Math.random): RequestHandler {
  return (_req, res, next) => {
    if (mode === 'errors' && random() < 0.3) {
      res.status(500).json({ error: 'injected fault' });
      return;
    }
    if (mode === 'latency') {
      setTimeout(next, 800);
      return;
    }
    next();
  };
}
