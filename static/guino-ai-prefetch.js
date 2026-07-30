/**
 * Prefetch and cache AI API responses so Study/Courses pages render instantly
 * after time on the landing scene.
 */
(function () {
    const bootstrapAt = performance.now();
    const PREFIX = 'guino_ai_cache:';
    const TTL_MS = 15 * 60 * 1000;

    const AI_ENDPOINTS = [
        '/api/study_plan',
        '/api/flashcards',
        '/api/courses_info',
    ];

    const inflight = new Map();

    function cacheKey(path) {
        return PREFIX + path;
    }

    function read(path) {
        try {
            const raw = sessionStorage.getItem(cacheKey(path));
            if (!raw) return null;
            const entry = JSON.parse(raw);
            if (!entry || typeof entry.fetchedAt !== 'number') {
                sessionStorage.removeItem(cacheKey(path));
                return null;
            }
            if (Date.now() - entry.fetchedAt > TTL_MS) {
                sessionStorage.removeItem(cacheKey(path));
                return null;
            }
            return entry.data;
        } catch {
            return null;
        }
    }

    function write(path, data) {
        try {
            sessionStorage.setItem(
                cacheKey(path),
                JSON.stringify({ fetchedAt: Date.now(), data })
            );
        } catch (e) {
            console.warn('Guino AI cache: could not persist', e);
        }
    }

    function formatMs(ms) {
        return `${Math.round(ms)}ms`;
    }

    async function fetchAndCache(path, { logLabel } = {}) {
        const pending = inflight.get(path);
        if (pending) return pending;

        const startedAt = performance.now();
        const queueDelayMs = startedAt - bootstrapAt;

        if (logLabel) {
            console.info(
                `[Guino] AI prefetch started: ${path} (call queued ${formatMs(queueDelayMs)} after prefetch script)`
            );
        }

        const promise = fetch(path, { credentials: 'same-origin' })
            .then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then((data) => {
                write(path, data);
                if (logLabel) {
                    const elapsedMs = performance.now() - startedAt;
                    console.info(
                        `[Guino] AI prefetch complete: ${path} (request took ${formatMs(elapsedMs)})`
                    );
                }
                return data;
            })
            .catch((err) => {
                if (logLabel) {
                    const elapsedMs = performance.now() - startedAt;
                    console.warn(
                        `[Guino] AI prefetch failed: ${path} (after ${formatMs(elapsedMs)})`,
                        err
                    );
                }
                throw err;
            })
            .finally(() => {
                inflight.delete(path);
            });

        inflight.set(path, promise);
        return promise;
    }

    async function get(path) {
        const cached = read(path);
        if (cached !== null) return cached;
        return fetchAndCache(path);
    }

    function isLandingEntry() {
        if (document.querySelector('script[data-guino-landing-prefetch]')) return true;
        const path = window.location.pathname.replace(/\/$/, '') || '/';
        return path === '' || path === '/';
    }

    function prefetchAll(options = {}) {
        const force = options.force === true;
        const log = options.log === true;
        AI_ENDPOINTS.forEach((path) => {
            if (!force && read(path) !== null) return;
            fetchAndCache(path, { logLabel: log }).catch(() => {});
        });
    }

    function isCached(path) {
        return read(path) !== null;
    }

    window.GuinoAiCache = {
        get,
        prefetchAll,
        isCached,
        readSync: read,
        endpoints: AI_ENDPOINTS,
    };

    if (isLandingEntry()) {
        console.info(
            `[Guino] Landing load — warming AI endpoints in parallel (${formatMs(performance.now() - bootstrapAt)} after prefetch script)`
        );
        prefetchAll({ force: true, log: true });
    } else {
        prefetchAll();
    }
})();
