export function registerImageRoutes(app, { images }) {
  app.get('/api/image', async (req, res) => images.serve(req, res));
}
