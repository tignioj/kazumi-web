import { verificationOwner } from './interactive.js';

export function registerVerificationRoutes(app, { verification }) {
  app.get('/api/verification-session', (req, res) => {
    verificationOwner(req, res, true);
    res.set('Cache-Control', 'no-store').json({ ok: true });
  });
  app.use('/api/verification', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/verification/:id', async (req, res) => {
    res.json(await verification.snapshot(verificationOwner(req, res), req.params.id));
  });
  app.post('/api/verification/:id/action', async (req, res) => {
    res.json(await verification.action(verificationOwner(req, res), req.params.id, req.body));
  });
  app.delete('/api/verification/:id', (req, res) => {
    verification.cancel(verificationOwner(req, res), req.params.id);
    res.json({ ok: true });
  });
}
