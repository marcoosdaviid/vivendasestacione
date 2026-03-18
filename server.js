const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 4173;
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.db.enc');
const AVAILABILITIES_FILE = path.join(DATA_DIR, 'availabilities.json');
const SESSION_STORAGE_KEY = 'condopark_session_user';
const STATUS = { AVAILABLE: 'AVAILABLE', FINISHED: 'FINISHED' };
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const secretSource = process.env.APP_SECRET_KEY || crypto.randomBytes(32).toString('hex');
if (!process.env.APP_SECRET_KEY) {
  console.warn('[CondoPark] APP_SECRET_KEY not found. Using a temporary key for this process only.');
}
const ENCRYPTION_KEY = crypto.createHash('sha256').update(secretSource).digest();
const HASH_PREFIX = 'scrypt$';

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) {
    writeEncryptedUsers({ users: [] });
  }
  if (!fs.existsSync(AVAILABILITIES_FILE)) {
    fs.writeFileSync(AVAILABILITIES_FILE, JSON.stringify({ availabilities: [] }, null, 2));
  }
}

function encryptPayload(payload) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('hex'), data: encrypted.toString('hex') });
}

function decryptPayload(raw) {
  const parsed = JSON.parse(raw);
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, Buffer.from(parsed.iv, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(parsed.data, 'hex')), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function writeEncryptedUsers(payload) {
  fs.writeFileSync(USERS_FILE, encryptPayload(payload));
}

function readEncryptedUsers() {
  ensureDataFiles();
  try {
    const payload = decryptPayload(fs.readFileSync(USERS_FILE, 'utf8'));
    return payload && Array.isArray(payload.users) ? payload : { users: [] };
  } catch (error) {
    console.warn('[CondoPark] Failed to decrypt users.db.enc. Resetting encrypted storage.');
    const empty = { users: [] };
    writeEncryptedUsers(empty);
    return empty;
  }
}

function readAvailabilities() {
  ensureDataFiles();
  const parsed = JSON.parse(fs.readFileSync(AVAILABILITIES_FILE, 'utf8'));
  return Array.isArray(parsed.availabilities) ? parsed.availabilities : [];
}

function writeAvailabilities(availabilities) {
  fs.writeFileSync(AVAILABILITIES_FILE, JSON.stringify({ availabilities }, null, 2));
}

function generateId(prefix) {
  return prefix + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function sanitizeUser(user) {
  return { id: user.id, name: user.name, apartment: user.apartment, phone: user.phone };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return HASH_PREFIX + salt + '$' + hash;
}

function comparePassword(password, storedHash) {
  if (!storedHash || !storedHash.startsWith(HASH_PREFIX)) {
    return false;
  }
  const parts = storedHash.split('$');
  const salt = parts[1];
  const expected = parts[2];
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function syncStatuses(availabilities) {
  const now = Date.now();
  let changed = false;
  const updated = availabilities.map(function (availability) {
    if (availability.status === STATUS.AVAILABLE && new Date(availability.endTime).getTime() <= now) {
      changed = true;
      return Object.assign({}, availability, { status: STATUS.FINISHED });
    }
    return availability;
  });
  if (changed) {
    writeAvailabilities(updated);
  }
  return updated;
}

function parseBody(req) {
  return new Promise(function (resolve, reject) {
    let data = '';
    req.on('data', function (chunk) {
      data += chunk;
      if (data.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', function () {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  fs.readFile(filePath, function (error, content) {
    if (error) {
      sendJson(res, 404, { message: 'Not found' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, {
      sessionStorageKey: SESSION_STORAGE_KEY,
      status: STATUS,
      passwordHashAlgorithm: 'scrypt-fallback'
    });
    return true;
  }

  if (pathname === '/api/signup' && req.method === 'POST') {
    const body = await parseBody(req);
    const name = String(body.name || '').trim();
    const apartment = String(body.apartment || '').trim();
    const phone = normalizePhone(body.phone);
    const password = String(body.password || '');

    if (!name || !apartment || !phone || !password) {
      sendJson(res, 400, { message: 'Preencha todos os campos.' });
      return true;
    }
    if (password.length < 4) {
      sendJson(res, 400, { message: 'A senha deve ter pelo menos 4 caracteres.' });
      return true;
    }

    const storage = readEncryptedUsers();
    if (storage.users.some(function (user) { return user.phone === phone; })) {
      sendJson(res, 409, { message: 'Esse telefone já está cadastrado.' });
      return true;
    }

    const user = {
      id: generateId('user'),
      name,
      apartment,
      phone,
      passwordHash: hashPassword(password)
    };
    storage.users.push(user);
    writeEncryptedUsers(storage);
    sendJson(res, 201, { user: sanitizeUser(user) });
    return true;
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const phone = normalizePhone(body.phone);
    const password = String(body.password || '');
    const storage = readEncryptedUsers();
    const user = storage.users.find(function (item) { return item.phone === phone; });

    if (!user || !comparePassword(password, user.passwordHash)) {
      sendJson(res, 401, { message: 'Telefone ou senha inválidos.' });
      return true;
    }

    sendJson(res, 200, { user: sanitizeUser(user) });
    return true;
  }

  if (pathname === '/api/availabilities' && req.method === 'GET') {
    const users = readEncryptedUsers().users;
    const availabilities = syncStatuses(readAvailabilities()).map(function (availability) {
      const owner = users.find(function (user) { return user.id === availability.ownerId; });
      return Object.assign({}, availability, { owner: owner ? sanitizeUser(owner) : null });
    });
    sendJson(res, 200, { availabilities });
    return true;
  }

  if (pathname === '/api/availabilities' && req.method === 'POST') {
    const body = await parseBody(req);
    const ownerId = String(body.ownerId || '');
    const startTime = String(body.startTime || '');
    const endTime = String(body.endTime || '');
    const users = readEncryptedUsers().users;
    const owner = users.find(function (user) { return user.id === ownerId; });

    if (!owner) {
      sendJson(res, 400, { message: 'Usuário inválido.' });
      return true;
    }
    if (!startTime || !endTime) {
      sendJson(res, 400, { message: 'Preencha início e fim.' });
      return true;
    }
    if (new Date(startTime).getTime() >= new Date(endTime).getTime()) {
      sendJson(res, 400, { message: 'O início precisa ser menor que o fim.' });
      return true;
    }

    const availabilities = readAvailabilities();
    const availability = {
      id: generateId('availability'),
      ownerId,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      status: STATUS.AVAILABLE
    };
    availabilities.push(availability);
    writeAvailabilities(availabilities);
    sendJson(res, 201, { availability: Object.assign({}, availability, { owner: sanitizeUser(owner) }) });
    return true;
  }

  return false;
}

const server = http.createServer(async function (req, res) {
  try {
    const url = new URL(req.url, 'http://localhost:' + PORT);
    if (await handleApi(req, res, url.pathname)) {
      return;
    }

    let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(ROOT_DIR, pathname);
    if (!filePath.startsWith(ROOT_DIR)) {
      sendJson(res, 403, { message: 'Forbidden' });
      return;
    }
    sendFile(res, filePath);
  } catch (error) {
    sendJson(res, 500, { message: 'Internal server error', error: error.message });
  }
});

ensureDataFiles();
server.listen(PORT, function () {
  console.log('[CondoPark] Running on http://localhost:' + PORT);
});
