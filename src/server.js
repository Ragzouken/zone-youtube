const { promisify } = require("util");
const { dirname } = require("path");
const { mkdir, unlink } = require("fs").promises;
const youtubedl = require('youtube-dl');
const youtubedl2 = require('youtube-dl-exec')

const express = require("express");
const ytsr = require('ytsr');

require('dotenv').config();
require('dotenv').config({ path: ".env.defaults" });

mkdir(process.env.MEDIA_PATH).catch(() => {});
mkdir(dirname(process.env.DATA_PATH)).catch(() => {});

const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync');
const db = low(new FileSync(process.env.DATA_PATH, { serialize: JSON.stringify, deserialize: JSON.parse }));

const MEDIA_PATH = process.env.MEDIA_PATH;

process.title = "zone youtube";

/** 
 * @typedef {Object} VideoMetadata
 * @property {string} mediaId
 * @property {string} title
 * @property {number} duration
 * @property {string?} thumbnail
 * @property {string?} src
 */

db.defaults({
    metas: [],
    saved: [],
    statuses: [],
}).write();

/** @type Map<string, VideoMetadata> */
const metas = new Map(db.get("metas"));
/** @type Set<string> */
const saved = new Set(db.get("saved"));
/** @type Map<string, string> */
const statuses = new Map(db.get("statuses"));

function save() {
    db.set("metas", Array.from(metas).filter(([videoId, metadata]) => saved.has(videoId))).write();
    db.set("saved", Array.from(saved)).write();
    db.set("statuses", Array.from(statuses)).write();
}

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

async function getFilteredSearch(query) {
    try {
        const filters = await ytsdr.getFilters(query);
        return filters.get('Type').get('Video').url;
    } catch (e) {
        return query;
    }
}

/**
 * @param {any} options 
 * @returns {Promise<VideoMetadata[]>}
 */
async function searchYoutube(options) {
    const search = await getFilteredSearch(options.q)
    const result = await ytsr(search, { limit: 15 });
    const videos = result.items.filter((item) => item.type === "video" && !item.isLive && item.duration);
    /** @type {VideoMetadata[]} */
    const entries = videos.map((video) => ({
        mediaId: video.id,
        title: video.title,
        duration: timeToSeconds(video.duration) * 1000,
        thumbnail: video.bestThumbnail.url,
    }));
    entries.forEach((entry) => metas.set(entry.mediaId, entry));
    return entries;
}

const youtubeGetInfo = promisify(youtubedl.getInfo);

/**
 * @param {string} youtubeId 
 * @returns {VideoMetadata}
 */
async function getMetaRemote(youtubeId) {
    const url = "https://youtube.com/watch?v=" + youtubeId;
    const { title, duration } = await youtubeGetInfo(url, ['--force-ipv4']);
    const meta = { 
        mediaId: youtubeId, 
        title, 
        duration: timeToSeconds(duration) * 1000,
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
    const youtubeUrl = `http://www.youtube.com/watch?v=${youtubeId}`;

    try {
        console.log("DOWNLOADING", youtubeId, "TO", path)
        const { title, duration, id } = await youtubedl2(youtubeUrl, {
            format: "18",
            forceIpv4: true,
            o: path,
            dumpSingleJson: true,
        });

        const meta = { 
            title, 
            duration: duration * 1000, 
            mediaId: id,
            src: `${process.env.MEDIA_PATH_PUBLIC}/${id}.mp4`,
        };
        
        console.log("SUCCESS", youtubeId, "IS", meta, "AT", path);

        metas.set(id, meta);
        statuses.set(youtubeId, "available");
        saved.add(youtubeId);
    } catch (error) {
        statuses.set(youtubeId, "failed");
        console.log("error", error);
        console.log("DELETING", youtubeId, "FROM", path);
        await unlink(path).catch(() => {});
    }
}

app.delete("/youtube/:id", requireAuth, async (request, response) => {
    const youtubeId = request.params.id;
    saved.delete(youtubeId);
    statuses.delete(youtubeId);
    response.status(200);
});

// general libraries API
app.get("/youtube", async (request, response) => {
    if (request.query && request.query.q) {
        try {
            let entries = await searchYoutube(request.query || {});
            response.json(entries.slice(0, 5));
        } catch (error) {
            response.status(503).send(`search failure: ${error}`);
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
    } catch (e) {
        response.status(502).send(`access blocked by youtube`);
    }
});

app.get("/youtube/:id/status", async (request, response) => {
    const status = statuses.get(request.params.id) || "none";
    response.json(status);
});

app.post("/youtube/:id/request", requireAuth, async (request, response) => {
    const youtubeId = request.params.id;
    const status = statuses.get(youtubeId) || "none";

    response.status(202).send();

    if (status === "requested" || status === "available") {
        console.log("redundant request", youtubeId, status);
        return;
    } else {
        statuses.set(youtubeId, "requested");
        requestQueue.push(youtubeId);
    }

    lastDownload = lastDownload.then(
        () => downloadYoutubeVideo(youtubeId),
        () => downloadYoutubeVideo(youtubeId),
    );
});
//

const listener = app.listen(process.env.PORT, process.env.HOST, () => {
    console.log("zone youtube serving on " + listener.address().port);
});

function timeToSeconds(time) {
    const parts = time.split(':');

    const seconds = parseInt(parts.pop() || '0', 10);
    const minutes = parseInt(parts.pop() || '0', 10);
    const hours = parseInt(parts.pop() || '0', 10);

    return seconds + minutes * 60 + hours * 3600;
}
