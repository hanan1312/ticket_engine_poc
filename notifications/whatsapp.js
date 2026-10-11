


const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
// eagle_api/whatsapp.js

const clients = new Map();
const centerStatuses = new Map();

const authTimeouts = new Map(); 
const failedAt = new Map();  // centerId -> time the browser last failed to start
const RETRY_AFTER_MS = 60000;

const delay = ms => new Promise(res => setTimeout(res, ms));

// ==========================================
// Browser selection
// ==========================================
// A snap-packaged Chromium (Ubuntu's default: /snap/bin/chromium, and /usr/bin/chromium-browser
// is just a wrapper that runs the snap) is confined: it can only write inside the user's home
// folder, has its own private /tmp, starts slowly the first time, and crashes with the
// --single-process / --no-zygote flags. It works once those are accounted for, but a normal
// (non-snap) Chrome is more reliable, so snap is the last choice.
const isSnapBrowser = (file) => {
    try {
        if (fs.realpathSync(file).startsWith('/snap/')) return true;
        // Ubuntu's /usr/bin/chromium(-browser) transitional packages are shell scripts calling the snap.
        const head = fs.readFileSync(file, { encoding: 'utf8', flag: 'r' }).slice(0, 2000);
        return head.startsWith('#!') && /\/snap\/|snap run|snap install/.test(head);
    } catch (e) {
        return false;
    }
};

// Which Chrome/Chromium to drive -> { path, snap } or null. Order: PUPPETEER_EXECUTABLE_PATH,
// Google Chrome, a non-snap Chromium, the Chrome `npm install` downloaded for puppeteer
// (~/.cache/puppeteer, x86_64 only), and finally a snap Chromium.
const findBrowser = () => {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        const forced = process.env.PUPPETEER_EXECUTABLE_PATH;
        return fs.existsSync(forced) ? { path: forced, snap: isSnapBrowser(forced) } : null;
    }
    const system = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
                    '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(p => fs.existsSync(p));
    const native = system.find(p => !isSnapBrowser(p));
    if (native) return { path: native, snap: false };
    try {
        const bundled = require('puppeteer').executablePath();
        if (bundled && fs.existsSync(bundled)) return { path: bundled, snap: false };
    } catch (e) { /* puppeteer has no browser download for this platform */ }
    const snap = ['/snap/bin/chromium', ...system].find(p => fs.existsSync(p));
    return snap ? { path: snap, snap: true } : null;
};

// Where LocalAuth keeps the paired session (and Chrome's profile). Next to this file normally;
// for a snap browser it must be a folder the snap may write to -- inside $HOME and not under a
// hidden top-level folder -- so fall back to the snap's own data folder when this one isn't.
const authDirFor = (browser) => {
    const local = path.join(__dirname, '.wwebjs_auth');
    if (!browser || !browser.snap) return local;
    const home = os.homedir();
    const rel = path.relative(home, __dirname);
    const insideHome = rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep)[0].startsWith('.');
    return insideHome ? local : path.join(home, 'snap', 'chromium', 'common', 'wwebjs_auth');
};

const BROWSER = findBrowser();
const AUTH_DIR = authDirFor(BROWSER);

const BASE_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-default-browser-check',
    '--safebrowsing-disable-auto-update'
];
// Memory savers for small servers -- but a snap Chromium crashes or never answers with them.
const LOW_MEMORY_ARGS = ['--no-zygote', '--single-process'];

const puppeteerOptions = (browser) => ({
    executablePath: browser.path,
    headless: true,
    args: browser.snap ? BASE_ARGS : [...BASE_ARGS, ...LOW_MEMORY_ARGS],
    // A snap's first start (and any start on a 1 GB VM) can take well over puppeteer's 30s default.
    timeout: 180000,
    protocolTimeout: 300000,
});

// ==========================================
// 🚨 NEW SELF-HEALING LOGIC
// ==========================================
const wipeSessionAndRestart = (centerId) => {
    console.log(`[${centerId}] 🧹 Wiping expired session data...`);
    // This targets the folder LocalAuth keeps the session in (AUTH_DIR)
    const sessionPath = AUTH_DIR;
    
    try {
        if (fs.existsSync(sessionPath)) {
            // Delete the corrupted session folder completely
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`[${centerId}] ✅ Expired session deleted.`);
        }
    } catch (err) {
        console.error(`[${centerId}] Error deleting session folder:`, err);
    }
    
    console.log(`[${centerId}] 🔄 Exiting process. PM2 will now restart the bot and generate a new QR Code...`);
    // Exiting with code 1 tells PM2 to instantly reboot the microservice
    process.exit(1); 
};
// ==========================================

const initializeClient = (centerId) => {
    if (clients.has(centerId)) return;

    if (!BROWSER) {
        console.error(`[${centerId}] ❌ No Chrome/Chromium found. Install one (see deploy/README.md) or set PUPPETEER_EXECUTABLE_PATH.`);
        failedAt.set(centerId, Date.now());
        centerStatuses.set(centerId, { status: 'error', message: 'No Chrome/Chromium browser installed on the server -- install one or set PUPPETEER_EXECUTABLE_PATH, then restart the WhatsApp service.' });
        return;  // not added to `clients`, so a later status poll tries again
    }
    centerStatuses.set(centerId, { status: 'initializing', message: `Starting WhatsApp..${BROWSER.snap ? ' (snap Chromium -- the first start can take a minute)' : ''}` });
    console.log(`[${centerId}] Starting New WhatsApp Session... (browser: ${BROWSER.path}${BROWSER.snap ? ', snap' : ''}; session folder: ${AUTH_DIR})`);
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: centerId, dataPath: AUTH_DIR }), 
        puppeteer: puppeteerOptions(BROWSER),
    });

    client.on('qr', (qr) => {
        console.log(`[${centerId}] A New QR code Is Generated.`);
        
        qrcode.generate(qr, {small: true}); 
        
        centerStatuses.set(centerId, { status: 'qr', qrCode: qr, message: 'Waiting for Scanning The QR Code ...' });
        
        if (!authTimeouts.has(centerId)) {
            const timeout = setTimeout(() => {
                console.log(`[${centerId}] ⏳ Session Being Closed For Memory Saving.`);
                centerStatuses.set(centerId, { status: 'offline', message: 'Session Expired, Please Start New One...' });
                client.destroy(); 
                clients.delete(centerId);
                authTimeouts.delete(centerId);
            }, 120000); 
            authTimeouts.set(centerId, timeout);
        }
    });
    const isCommunicationReady = new Map();
    client.on('ready', () => {
        console.log(`[${centerId}] ✅ Whats App Connected Succsessfully!`);
        centerStatuses.set(centerId, { status: 'connected', message: 'Connecting And Ready For Automatic Messaging' });
        
        setTimeout(() => {
            isCommunicationReady.set(centerId, true);
            centerStatuses.set(centerId, { status: 'connected', message: 'Ready' });
        }, 5000);
    });

    // 🚨 UPDATED TO USE WIPE FUNCTION
    client.on('disconnected', (reason) => {
        console.log(`[${centerId}] ❌ تم قطع الاتصال: ${reason}`);
        centerStatuses.set(centerId, { status: 'offline', message: 'Phone Disconnected' });
        clients.delete(centerId);
        client.destroy().then(() => wipeSessionAndRestart(centerId)).catch(() => wipeSessionAndRestart(centerId)); 
    });

    // 🚨 UPDATED TO USE WIPE FUNCTION
    client.on('auth_failure', msg => {
        console.error(`[${centerId}] ❌Pairing Failure :`, msg);
        centerStatuses.set(centerId, { status: 'offline', message: 'Failed To Connect, Please Try Again' });
        clients.delete(centerId);
        client.destroy().then(() => wipeSessionAndRestart(centerId)).catch(() => wipeSessionAndRestart(centerId));
    });

    client.initialize().catch(err => {
         console.error(`[${centerId}] ❌ ERR: Connection Time Out:`, err);
         const hint = BROWSER.snap
             ? ' -- snap Chromium is unreliable here; install Google Chrome (x86_64) or a non-snap Chromium (ARM), or set PUPPETEER_EXECUTABLE_PATH.'
             : '';
         if (hint) console.error(`[${centerId}] Hint:${hint}`);
         centerStatuses.set(centerId, { status: 'error', message: `Error opening the browser: ${(err && err.message) || err}${hint}` });
         client.destroy().catch(() => {});
         clients.delete(centerId);  // let a later status poll retry instead of staying stuck
         failedAt.set(centerId, Date.now());
    });
    
    clients.set(centerId, client); 
};

const getStatus = (centerId) => {
    if (!clients.has(centerId)) {
        // After a failed start, report the failure and retry at most once a minute rather than
        // relaunching a browser on every status poll.
        if (Date.now() - (failedAt.get(centerId) || 0) > RETRY_AFTER_MS) initializeClient(centerId);
        return centerStatuses.get(centerId) || { status: 'offline', message: 'Processing..' };
    }
    return centerStatuses.get(centerId) || { status: 'offline' };
};

const logoutClient = async (centerId) => {
    const client = clients.get(centerId);
    if (client) {
        try {
            await client.destroy(); 
        } catch (e) {
            console.log(`[${centerId}] Error during destroy:`, e.message);
        }
        clients.delete(centerId);
        centerStatuses.set(centerId, { status: 'offline', message: 'تم تسجيل الخروج بنجاح' });
        console.log(`[${centerId}] 🧹 Logged Out Successfully`);
        
        // Also wipe session on manual logout to keep things clean!
        wipeSessionAndRestart(centerId);
    }
};

// Puppeteer throws these when the underlying page reloaded or lost context mid-operation
// (e.g. WhatsApp Web re-rendering against a newer bundle than our cached one) — the client
// object is left holding stale frame/execution-context references and every subsequent send
// fails the same way until something recycles it. None of our own event handlers
// (disconnected/auth_failure) catch this case since WhatsApp itself never actually
// disconnected, so we detect it here and reinitialize instead of leaving it broken.
const isRecoverableBrowserError = (error) => {
    const msg = (error && error.message) || '';
    return /detached Frame|Session closed|Target closed|Execution context was destroyed|Protocol error/i.test(msg);
};

const reinitializeClient = async (centerId) => {
    console.log(`[${centerId}] 🔁 Recovering from a broken browser session — reinitializing...`);
    const client = clients.get(centerId);
    clients.delete(centerId);
    centerStatuses.set(centerId, { status: 'initializing', message: 'Recovering connection...' });
    if (client) {
        try {
            await client.destroy();
        } catch (e) {
            // Already broken — nothing to clean up.
        }
    }
    // LocalAuth's persisted session means this comes back without a fresh QR scan, as long
    // as WhatsApp itself never actually logged the session out.
    initializeClient(centerId);
};

const sendMessage = async (centerId, phone, message, pdfUrl = null) => {
    const client = clients.get(centerId);
    if (!client) throw new Error("لم يتم تشغيل الواتساب لهذا السنتر بعد");

    const status = centerStatuses.get(centerId);
    if (status && status.status !== 'connected') throw new Error("الواتساب غير متصل، يرجى مسح الباركود أولاً");

    try {
        // FIX 1: Safely cast the phone variable to a string before trimming
        let formattedPhone = String(phone).trim();
        if (formattedPhone.startsWith('01')) formattedPhone = `2${formattedPhone}`;
        else if (!formattedPhone.startsWith('20')) formattedPhone = `20${formattedPhone}`;

        const chatId = `${formattedPhone}@c.us`;

        const isRegistered = await client.isRegisteredUser(chatId);
        if (!isRegistered) {
            console.log(`[${centerId}] ⚠️ The Number ${formattedPhone} Has No WhatsApp Service.`);
            return false;
        }

        // FIX 2: Safely check if the chat exists before applying typing indicators
        try {
            const chat = await client.getChatById(chatId);
            if (chat) {
                await chat.sendStateTyping();
                await delay(Math.floor(Math.random() * 2000) + 1500);
            }
        } catch (chatError) {
            console.log(`[${centerId}] No prior chat history, skipping typing indicator.`);
        }

        if (pdfUrl) {
            try {
                const media = await MessageMedia.fromUrl(pdfUrl);
                await client.sendMessage(chatId, media, { caption: message });
                console.log(`[${centerId}] 📩 PDF & Message sent to: ${formattedPhone}`);
            } catch (mediaError) {
                console.error(`[${centerId}] Failed to download PDF:`, mediaError);
                await client.sendMessage(chatId, message + `\n\nLink: ${pdfUrl}`);
            }
        } else {
            await client.sendMessage(chatId, message);
            console.log(`[${centerId}] 📩 Text sent to: ${formattedPhone}`);
        }
        
        try {
            const chat = await client.getChatById(chatId);
            if (chat) await chat.clearState();
        } catch (e) {}

        return true;
    } catch (error) {
        console.error(`[${centerId}] ❌ Failed To Send To : ${phone}:`, error.message);
        if (isRecoverableBrowserError(error)) {
            // Fire-and-forget: this send still fails and reports back to the caller as
            // before, but the next one gets a healthy client instead of the same broken one.
            reinitializeClient(centerId).catch(err =>
                console.error(`[${centerId}] Failed to reinitialize after browser error:`, err.message));
        }
        throw error;
    }
};


module.exports = { getStatus, logoutClient, sendMessage };

