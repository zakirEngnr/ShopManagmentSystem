import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { resolveUploadDir } from './services/upload.service.js';
import { IMAGE_NAME_RE } from './middleware/upload.js';
import apiRoutes from './routes/index.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

// Inside app.use('/uploads', ...) Express strips the mount prefix, so req.path
// is '/<name>' (not '/uploads/<name>'). Match the image name only.
const uploadFileRe = new RegExp('^\\/(?:' + IMAGE_NAME_RE.source.slice(1, -1) + ')$');

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  const uploadDir = resolveUploadDir();

  // 1) Guard on /uploads: only GET/HEAD of /uploads/<valid image name>.
  //    Blocks traversal, dotfiles, directory listings, non-image files and
  //    any non-GET/HEAD method with a fixed 404 body (no paths leak).
  app.use('/uploads', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(404).json({ ok: false, error: { message: 'Not found' } });
      return;
    }
    if (!uploadFileRe.test(req.path)) {
      res.status(404).json({ ok: false, error: { message: 'Not found' } });
      return;
    }
    next();
  });

  // 2) Serve uploaded images with restrictive headers.
  app.use(
    '/uploads',
    express.static(uploadDir, {
      index: false,
      dotfiles: 'deny',
      redirect: false,
      fallthrough: true,
      setHeaders: (res) => {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );

  // 3) Final fixed 404 for /uploads (missing file, etc.) — never an error
  //    object, so no filesystem path can reach errorHandler.
  app.use('/uploads', (req, res) => {
    res.status(404).json({ ok: false, error: { message: 'Not found' } });
  });

  app.use('/api', apiRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export default createApp;
