const { promisify } = require("util");
const { dirname } = require("path");
const { mkdir } = require("fs").promises;
const { createWriteStream, stat } = require('fs');
const youtubedl = require('youtube-dl');

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
 * @property {string} youtubeId
 * @property {string} title
 * @property {number} duration
 */

db.defaults({
    metas: [],
    saved: [],
}).write();

/** @type Map<string, VideoMetadata> */
const metas = new Map(db.get("metas"));
/** @type Set<string> */
const saved = new Set(db.get("saved"));
/** @type Map<string, string> */
const statuses = new Map();

function save() {
    db.set("metas", Array.from(metas)).write();
    db.set("saved", Array.from(saved)).write();
}

process.on('SIGINT', () => {
    console.log("saved");
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

async function searchYoutube(options) {
    const search = await getFilteredSearch(options.q)
    const result = await ytsr(search, { limit: 30 });
    const videos = result.items.filter((item) => item.type === "video" && !item.isLive && item.duration);
    const entries = videos.map((video) => ({
        youtubeId: video.id,
        title: video.title,
        duration: timeToSeconds(video.duration) * 1000,
        thumbnail: video.bestThumbnail.url,
    }));
    entries.forEach((entry) => metas.set(entry.youtubeId, entry));
    return entries;
}

app.get("/youtube", async (request, response) => {
    if (request.query && request.query.q) {
        let entries = await searchYoutube(request.query || {});
        response.json(entries);
    } else {
        response.status(400).json("Search query q is required.");
    }
});

const youtubeGetInfo = promisify(youtubedl.getInfo);

/**
 * @param {string} youtubeId 
 * @returns {VideoMetadata}
 */
async function getMetaRemote(youtubeId) {
    const url = "https://youtube.com/watch?v=" + youtubeId;
    const { title, duration } = await youtubeGetInfo(url);
    const meta = { 
        youtubeId, 
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

app.post("/youtube/:id/request", requireAuth, async (request, response) => {
    const youtubeId = request.params.id;
    const status = statuses.get(youtubeId) || "none";

    if (status === "requested" || status === "available") {
        response.json(metas.get(youtubeId));
        console.log("redundant request", youtubeId);
        return;
    }

    const youtubeUrl = `http://www.youtube.com/watch?v=${youtubeId}`;
    const video = youtubedl(youtubeUrl, ['--format=18'], { cwd: __dirname });
    const path = `${MEDIA_PATH}/${youtubeId}.mp4`;
    statuses.set(youtubeId, "requested");

    video.on('info', function(info) {
        const { title, duration, id } = info;
        const meta = { 
            title, 
            duration: timeToSeconds(duration) * 1000, 
            youtubeId: id,
            src: `${process.env.MEDIA_PATH_PUBLIC}/${id}.mp4`,
        };
        metas.set(id, meta);
        console.log("downloading", meta);
        response.status(202).json(meta);
    })

    video.on('error', (info) => {
        statuses.set(youtubeId, "failed");
        console.log("error", info);
    });

    video.on('end', () => {
        statuses.set(youtubeId, "available");
        saved.add(youtubeId);
        console.log("done");
    });

    video.pipe(createWriteStream(path));
});

app.get("/youtube/:id/info", async (request, response) => {
    try {
        const meta = await getMeta(request.params.id);
        const src = `${process.env.MEDIA_PATH_PUBLIC}/${meta.youtubeId}.mp4`
        //if (saved.has(meta.youtubeId)) 
        meta.source = src;
        response.json(meta);
    } catch (e) {
        response.status(502).send(`youtube problem: ${e}`);
    }
});

app.get("/youtube/:id/status", async (request, response) => {
    const youtubeId = request.params.id;
    const status = statuses.get(youtubeId) || "none";
    response.json(status);
});

app.delete("/youtube/:id", requireAuth, async (request, response) => {
    const youtubeId = request.params.id;
    saved.delete(youtubeId);
    statuses.delete(youtubeId);
    response.status(200);
});

const listener = app.listen(process.env.PORT, "localhost", () => {
    console.log("zone youtube serving on " + listener.address().port);
});

function timeToSeconds(time) {
    const parts = time.split(':');

    const seconds = parseInt(parts.pop() || '0', 10);
    const minutes = parseInt(parts.pop() || '0', 10);
    const hours = parseInt(parts.pop() || '0', 10);

    return seconds + minutes * 60 + hours * 3600;
}
