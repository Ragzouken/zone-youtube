import * as dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: ".env.defaults" });

process.title = "zone youtube";

const options = {
    host: process.env.HOST ?? "localhost",
    port: parseInt(process.env.PORT ?? "3000"), 
};

import { dirname } from "node:path";
import { mkdir, unlink, stat } from "node:fs/promises";

import express from "express";
import ytsr from "@distube/ytsr";
import execa from "execa";

mkdir(process.env.MEDIA_PATH).catch(() => {});
mkdir(dirname(process.env.DATA_PATH)).catch(() => {});

import { LowSync } from "lowdb";
import { JSONFileSync } from "lowdb/node";
import { fileURLToPath } from "node:url";

const db = new LowSync(new JSONFileSync(process.env.DATA_PATH));
db.read();
db.data ||= {
    metas: [],
    saved: [],
    statuses: [],
}
db.write();

function save() {
    db.data.metas = Array.from(metas).filter(([videoId, metadata]) => saved.has(videoId));
    db.data.saved = Array.from(saved);
    db.write();
}

const MEDIA_PATH = process.env.MEDIA_PATH;

/** 
 * @typedef {Object} VideoMetadata
 * @property {string} mediaId
 * @property {string} title
 * @property {number} duration
 * @property {string?} thumbnail
 * @property {string?} src
 * @property {number?} size
 */

/** @type Map<string, VideoMetadata> */
const metas = new Map(db.data.metas)
/** @type Set<string> */
const saved = new Set(db.data.saved);
/** @type Map<string, string> */
const statuses = new Map();
/** @type Map<string, number> */
const progresses = new Map();
/** @type Map<string, number> */
const expires = new Map();

const LIFETIME_MS = parseFloat(process.env.LIFETIME_HOURS ?? "1") * 60 * 60 * 1000;

saved.forEach((videoId) => statuses.set(videoId, "available"));
saved.forEach((videoId) => expires.set(videoId, performance.now() + LIFETIME_MS));

process.on('SIGINT', () => {
    save();
    process.exit();
});

const app = express();
app.use(express.json());
app.use(express.static("public"));
app.use("/" + process.env.MEDIA_PATH_PUBLIC, express.static(process.env.MEDIA_PATH));

/**
 * @param {express.Request} request 
 * @param {express.Response} response 
 * @param {express.NextFunction} next 
 */
function requireAuth(request, response, next) {
    const auth = request.headers.authorization;

    if (auth && auth.startsWith("Bearer") && auth.endsWith(process.env.PASSWORD)) {
        next();
    } else if (request.body && request.body.password === process.env.PASSWORD) {
        next();
    } else {
        response.status(401).json({ title: "Invalid password." });
    }
}

/**
 * @param {any} options 
 * @returns {Promise<VideoMetadata[]>}
 */
async function searchYoutube(options) {
    const result = await ytsr(options.q, { limit: 15, type: "video" });
    const videos = result.items.filter((item) => !item.isLive && item.duration);
    /** @type {VideoMetadata[]} */
    const entries = videos.map((video) => ({
        mediaId: video.id,
        title: video.name,
        duration: timeToSeconds(video.duration) * 1000,
        thumbnail: video.thumbnail,
    }));
    return entries;
}

/**
 * @param {string} youtubeId 
 * @returns {Promise<VideoMetadata>}
 */
async function getMetaRemote(youtubeId) {
    const url = "https://youtube.com/watch?v=" + youtubeId;
    const child = await execa(process.env.YT_DLP_PATH, [url, "--force-ipv4", "--dump-single-json"]);
    const { title, duration, filesize } = JSON.parse(child.stdout);

    const meta = { 
        title, 
        duration: duration * 1000, 
        mediaId: youtubeId,
        youtubeId,
        src: `${process.env.MEDIA_PATH_PUBLIC}/${youtubeId}.mp4`,
        filesize,
    };

    return meta;
}

async function getMeta(youtubeId) {
    const meta = metas.get(youtubeId) || await getMetaRemote(youtubeId);
    metas.set(youtubeId, meta);
    return meta;
}

/** @type {string[]} */
const requestQueue = [];
/** @type {Promise<void>} */
let lastDownload = Promise.resolve();

async function downloadYoutubeVideo(youtubeId) {
    const path = `${MEDIA_PATH}/${youtubeId}.mp4`;
    const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeId}`;
    let handle;

    try {
        const meta = await getMeta(youtubeId);
        console.log("DOWNLOADING", youtubeId, "TO", path);

        async function progress() {
            const size = (await stat(path + ".part").catch(() => 0)).size;
            progresses.set(youtubeId, size / meta.filesize);
        }

        handle = setInterval(progress, 1000);

        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);

        await execa(process.env.YT_DLP_PATH, [
            youtubeUrl, 
            `--force-ipv4`, 
            `-f bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best`,
            process.env.EXTRA_ARGS,
            `-o${path}`
        ], { execPath: __dirname });

        console.log("SUCCESS", youtubeId, "IS", meta, "AT", path);

        // progresses.set()
        statuses.set(youtubeId, "available");
        saved.add(youtubeId);
    } catch (error) {
        statuses.set(youtubeId, "failed");
        console.log("DOWNLOAD FAILURE", error);
        console.log("DELETING", youtubeId, "FROM", path);
        await unlink(path).catch(() => {});
    } finally {
        clearInterval(handle);
    }
}

async function deleteYoutubeVideo(youtubeId) {
    saved.delete(youtubeId);
    statuses.delete(youtubeId);
    expires.delete(youtubeId);

    const path = `${MEDIA_PATH}/${youtubeId}.mp4`;
    console.log("DELETING", youtubeId, "FROM", path);
    await unlink(path).catch(() => {});
}

app.delete("/youtube/:id", requireAuth, async (request, response) => {
    const youtubeId = request.params.id;
    deleteYoutubeVideo(youtubeId);
    response.status(200);
});

// general libraries API
app.get("/youtube", async (request, response) => {
    if (request.query && request.query.q) {
        try {
            let entries = await searchYoutube(request.query || {});
            response.json(entries.slice(0, 5));
        } catch (error) {
            console.log("SEARCH FAILURE", error);
            response.status(503).json(`search failure: ${error}`);
        }
    } else {
        response.json(Array.from(saved).map((id) => metas.get(id)));
    }
});

app.get("/youtube/:id", async (request, response) => {
    const youtubeId = request.params.id;
    try {
        const meta = await getMeta(youtubeId);
        meta.src = `${process.env.MEDIA_PATH_PUBLIC}/${youtubeId}.mp4`
        response.json(meta);
    } catch (error) {
        console.log("META FAILTURE", error);
        response.status(502).json(`access blocked by youtube`);
    }
});

app.get("/youtube/:id/status", async (request, response) => {
    const status = statuses.get(request.params.id) || "none";
    response.json(status);
});

app.get("/youtube/:id/progress", async (request, response) => {
    const progress = progresses.get(request.params.id) || 0;
    response.json(progress);
});

// app.get("/youtube/:id/request-test", async (request, response) => {
//     const youtubeId = request.params.id;
//     const status = statuses.get(youtubeId) || "none";

//     response.status(202).send();

//     if (status === "requested" || status === "available") {
//         console.log("redundant request", youtubeId, status);
//         return;
//     } else {
//         statuses.set(youtubeId, "requested");
//         requestQueue.push(youtubeId);
//     }

//     downloadYoutubeVideo(youtubeId);
// });

app.post("/youtube/:id/request", requireAuth, async (request, response) => {
    const youtubeId = request.params.id;
    const status = statuses.get(youtubeId) || "none";

    response.status(202).send();

    expires.set(youtubeId, performance.now() + LIFETIME_MS);

    if (status === "requested" || status === "available") {
        console.log("redundant request", youtubeId, status);
        return;
    } else {
        statuses.set(youtubeId, "requested");
        requestQueue.push(youtubeId);
    }

    /*
    lastDownload = lastDownload.then(
        () => downloadYoutubeVideo(youtubeId),
        () => downloadYoutubeVideo(youtubeId),
    );
    */

    // don't queue for now..
    downloadYoutubeVideo(youtubeId);
});
//

function expireVideos() {
    for (const [videoId, expiry] of expires) {
        if (expiry < performance.now()) {
            deleteYoutubeVideo(videoId);
        }
    }
}

setInterval(expireVideos, 60 * 1000);

const listener = app.listen(options.port, options.host, () => {
    console.log(`${process.title} serving on http://${listener.address().address}:${listener.address().port}`);
});

function timeToSeconds(time) {
    const parts = time.split(':');

    const seconds = parseInt(parts.pop() || '0', 10);
    const minutes = parseInt(parts.pop() || '0', 10);
    const hours = parseInt(parts.pop() || '0', 10);

    return seconds + minutes * 60 + hours * 3600;
}
