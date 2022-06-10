import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import axios, { AxiosAdapter } from 'axios';
import {
    cacheAdapterEnhancer,
    throttleAdapterEnhancer,
} from 'axios-extensions';
import Fastify, { fastify } from 'fastify';
import sharp, { FormatEnum } from 'sharp';

const imageRequest = axios.create({
    adapter: throttleAdapterEnhancer(
        cacheAdapterEnhancer(axios.defaults.adapter as AxiosAdapter),
        { threshold: 1000 * 5 }
    ),
});

const allowedHost = [...JSON.parse(process.env['ALLOWED_HOST'] || '[]')].map(
    (host: string) => new RegExp(host.replace('*', '.+'))
);

const prove = fastify();
prove.get('/live', () => Promise.resolve('OK'));

const server = Fastify({
    trustProxy: true,
    logger: true,
    ajv: {
        customOptions: {
            strict: 'log',
            keywords: ['kind', 'modifier'],
        },
    },
}).withTypeProvider<TypeBoxTypeProvider>();
server.get(
    '/',
    {
        schema: {
            querystring: Type.Object({
                url: Type.String({ format: 'uri' }),
                width: Type.Optional(Type.Number()),
                height: Type.Optional(Type.Number()),
                quality: Type.Number({
                    minimum: 1,
                    maximum: 100,
                    default: 80,
                }),
                blur: Type.Boolean({ default: false }),
                format: Type.Optional(
                    Type.String({
                        enum: [
                            'jpeg',
                            'jpg',
                            'png',
                            'webp',
                            'avif',
                            'tiff',
                            'tif',
                            'gif',
                            'raw',
                        ],
                    })
                ),
            }),
        },
    },
    async (request, reply) => {
        if (!allowedHost.some(h => h.test(new URL(request.query.url).host))) {
            reply.code(400);
            return Promise.reject(new Error('The provided url is not allowed'));
        }

        try {
            const baseImage = await imageRequest.get<ArrayBuffer>(
                request.query.url,
                {
                    responseType: 'arraybuffer',
                }
            );
            const baseFormat = baseImage.headers['content-type']?.startsWith(
                'image/'
            )
                ? baseImage.headers['content-type']?.replace('image/', '')
                : request.query.url.split('.').pop();
            const format = request.raw.headers['user-agent']?.includes(
                '+https://discordapp.com'
            )
                ? 'webp'
                : request.query.format ??
                  (
                      request
                          .accepts()
                          .type([
                              'image/avif',
                              'image/webp',
                              'image/tiff',
                              'image/gif',
                              'image/png',
                              'image/jpeg',
                          ]) as string
                  ).replace('image/', '') ??
                  baseFormat;
            const optimizer = sharp(Buffer.from(baseImage.data), {
                sequentialRead: true,
            });

            if (request.query.width || request.query.height) {
                const metadata = await optimizer.metadata();
                const width =
                    request.query.width && metadata.width
                        ? metadata.width >= request.query.width
                            ? request.query.width
                            : null
                        : null;
                const height =
                    request.query.height && metadata.height
                        ? metadata.height >= request.query.height
                            ? request.query.height
                            : null
                        : null;

                optimizer.resize(width, height, { fit: 'outside' });
            }

            if (request.query.blur) optimizer.blur(5);

            reply.header(
                'Cache-Control',
                'public, max-age=14400, s-maxage=84000'
            );
            reply.header('Cloudflare-CDN-Cache-Control', 'max-age=24400');
            reply.header('CDN-Cache-Control', 'max-age=18000');
            reply.header('Content-Type', `image/${format}`);

            return optimizer
                .toFormat(format as keyof FormatEnum, {
                    quality: request.query.quality,
                })
                .toBuffer();
        } catch (e) {
            reply.code(500);
            return Promise.reject(
                e instanceof Error ? new Error(e.message) : e
            );
        }
    }
);

['SIGTERM', 'SIGINT', 'SIGUSR2'].forEach(signal =>
    process.once(signal, () => prove.close().then(() => server.close()))
);

(async () => {
    await server.register(import('@fastify/cors'));
    await server.register(import('@fastify/accepts'));
    await server.register(import('@fastify/etag'));

    await server
        .listen({ port: 8080, host: '0.0.0.0' })
        .then(() => console.info('Server listening on port 8080'))
        .catch(e => console.error(e));

    await prove
        .listen({ port: 8888, host: '0.0.0.0' })
        .then(() => console.info('LiveProve listening on port 8888'))
        .catch(e => console.error(e));
})();
