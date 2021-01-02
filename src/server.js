const { nanoid } = require("nanoid");
const { parse, dirname, join } = require("path");
const { mkdir } = require("fs").promises;
const { createWriteStream } = require('fs');
const youtubedl = require('youtube-dl');

const express = require("express");
const ytsr = require('ytsr');
const joi = require("joi");

require('dotenv').config();
require('dotenv').config({ path: ".env.defaults" });

mkdir(process.env.MEDIA_PATH).catch(() => {});
mkdir(dirname(process.env.DATA_PATH)).catch(() => {});

const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync');
const db = low(new FileSync(process.env.DATA_PATH, { serialize: JSON.stringify, deserialize: JSON.parse }));

const MEDIA_PATH = process.env.MEDIA_PATH;

process.title = "zone youtube";

db.defaults({
    entries: [],
}).write();

const library = new Map(db.get("entries"));

function save() {
    db.set("entries", Array.from(library)).write();
}

process.on('SIGINT', () => {
    save();
    process.exit();
});

const app = express();
app.use(express.json());

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
 * @param {express.Request} request 
 * @param {express.Response} response 
 * @param {express.NextFunction} next 
 */
function requireLibraryEntry(request, response, next) {
    request.libraryEntry = library.get(request.params.id);

    if (request.libraryEntry) {
        next();
    } else {
        response.status(404).json({ title: "Entry does not exist." });
    }
}

function getLocalPath(info) {
    return join(MEDIA_PATH, info.filename);
}

async function searchYoutube(options) {
    const result = await ytsr(options.q, { limit: 30 });
    const videos = result.items.filter((item) => item.type === "video");
    const entries = videos.map((video) => ({
        youtubeId: video.id,
        title: video.title,
        duration: timeToSeconds(video.duration) * 1000,
        thumbnail: video.bestThumbnail.url,
    }));
    return entries;
}

app.get("/test", async (request, response) => {
    const video = youtubedl('http://www.youtube.com/watch?v=90AiXO1pAiA',
    // Optional arguments passed to youtube-dl.
    ['--format=18'],
    // Additional options can be given for calling `child_process.execFile()`.
    { cwd: __dirname });

    // Will be called when the download starts.
    video.on('info', function(info) {
        console.log('Download started')
        console.log('filename: ' + info._filename)
        console.log('size: ' + info.size);

        response.json(info);
    })

    video.on('error', (info) => {
        console.log("error", info);
    });

    video.on('end', () => {
        console.log("done");
    });

    video.pipe(createWriteStream('myvideo.mp4'));
});

app.get("/youtube", async (request, response) => {
    if (request.query && request.query.q) {
        let entries = await searchYoutube(request.query || {});
        response.json(entries);
    } else {
        response.status(400).json("Search query q is required.");
    }
});

app.get("/youtube/info/:id", (request, response) => {
    youtubedl.getInfo("https://youtube.com/watch?v=" + request.params.id, (err, info) => {
        const { title, duration } = info;

        response.json({ title, duration: timeToSeconds(duration) * 1000 });
    });
});

app.post("/youtube/:id", requireAuth, async (request, response) => {
    // request video
});

const tagSchema = joi.string().lowercase().min(1).max(32);
const patchSchema = joi.object({
    setTitle: joi.string().min(1).max(128),
    addTags: joi.array().items(tagSchema).default([]),
    delTags: joi.array().items(tagSchema).default([]),
});

app.delete("/youtube/:id", requireAuth, requireLibraryEntry, async (request, response) => {
    save();
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
