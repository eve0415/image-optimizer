import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import axios from 'axios';
import {
    buildMemoryStorage,
    defaultHeaderInterpreter,
    defaultKeyGenerator,
    setupCache,
} from 'axios-cache-interceptor';
import Fastify, { fastify } from 'fastify';
import sharp, { FormatEnum } from 'sharp';

const imageRequest = setupCache(axios.create(), {
    storage: buildMemoryStorage(),
    generateKey: defaultKeyGenerator,
    headerInterpreter: defaultHeaderInterpreter,
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

if (process.env['NODE_ENV'] === 'debug') {
    server.addHook('onRequest', async req => {
        console.debug(req.url);
        console.debug(req.headers);
    });
}

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
                    cache: { etag: true },
                }
            );
            const baseFormat = baseImage.headers['content-type']?.startsWith(
                'image/'
            )
                ? baseImage.headers['content-type']?.replace('image/', '')
                : request.query.url.split('.').pop();

            const format = (() => {
                // Discord cannot show avif image in the message
                if (
                    request.raw.headers['user-agent']?.includes(
                        '+https://discordapp.com'
                    )
                )
                    return 'webp';

                if (request.query.format) return request.query.format;

                // iOS 16+ support avif
                if (
                    /iPad|iPhone|iPod/.test(`${request.headers['user-agent']}`)
                ) {
                    const stripped = `${request.headers['user-agent']}`.match(
                        /OS (?<version>\d+)_(\d+)/
                    );
                    if (parseInt(stripped?.groups?.['version'] ?? '0') < 16)
                        return 'webp';
                }

                // From browser supported image format
                const browserSupport = request
                    .accepts()
                    .type([
                        'image/avif',
                        'image/webp',
                        'image/tiff',
                        'image/gif',
                        'image/png',
                        'image/jpeg',
                    ]) as string | undefined;
                if (browserSupport) return browserSupport.replace('image/', '');

                return baseFormat ?? 'webp';
            })();

            if (process.env['NODE_ENV'] === 'debug') {
                console.debug(request.accepts());
                console.debug(
                    request
                        .accepts()
                        .type([
                            'image/avif',
                            'image/webp',
                            'image/tiff',
                            'image/gif',
                            'image/png',
                            'image/jpeg',
                        ])
                );
                console.debug('base format: ', baseFormat);
                console.debug('selected format: ', format);
            }

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

            /**
             * Cache control
             * Browser: 1 day
             * Network Shared Cache: 3 days
             * Revalidate: 12 hours
             * Cloudflare Edge: 1 day 12 hours
             * Other CDNs: 1 day 6 hours
             */
            reply
                .header(
                    'Cache-Control',
                    'public, max-age=86400, s-maxage=259200 604800, stale-while-revalidate=43200'
                )
                .header('Cloudflare-CDN-Cache-Control', 'max-age=129600')
                .header('CDN-Cache-Control', 'max-age=108000')
                .header('Content-Type', `image/${format}`);

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

['uncaughtException', 'unhandledRejection'].forEach(signal =>
    process.on(signal, e =>
        console.error(`Signal: ${signal}\n`, handleAxiosError(e))
    )
);

function handleAxiosError(e: unknown) {
    if (!axios.isAxiosError(e)) return e;
    return e.toJSON();
}

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
