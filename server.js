const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.db.enc');
const AVAILABILITIES_FILE = path.join(DATA_DIR, 'availabilities.json');
const SESSION_STORAGE_KEY = 'condopark_session_user';
const STATUS = {
  AVAILABLE: 'AVAILABLE',
  FINISHED: 'FINISHED'
};
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const secretSource = process.env.APP_SECRET_KEY || crypto.randomBytes(32).toString('hex');
if (!process.env.APP_SECRET_KEY) {
  console.warn('[CondoPark] APP_SECRET_KEY ausente. Usando chave temporária apenas para esta execução.');
}
const ENCRYPTION_KEY = crypto.createHash('sha256').update(secretSource).digest();
const PASSWORD_PREFIX = 'scrypt$';

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(USERS_FILE)) {
    writeEncryptedUsers({ users: [] });
  }

  if (!fs.existsSync(AVAILABILITIES_FILE)) {
    fs.writeFileSync(AVAILABILITIES_FILE, JSON.stringify({ availabilities: [] }, null, 2));
  }
}

function encryptJson(payload) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);

  return JSON.stringify({
    iv: iv.toString('hex'),
    data: encrypted.toString('hex')
  });
}

function decryptJson(raw) {
  const payload = JSON.parse(raw);
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, Buffer.from(payload.iv, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'hex')),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

function readEncryptedUsers() {
  ensureStorage();
  const raw = fs.readFileSync(USERS_FILE, 'utf8');

  try {
    const payload = decryptJson(raw);
    return payload && Array.isArray(payload.users) ? payload : { users: [] };
  } catch (_error) {
    console.warn('[CondoPark] Não foi possível descriptografar users.db.enc. Reinicializando armazenamento de usuários.');
    const emptyPayload = { users: [] };
    writeEncryptedUsers(emptyPayload);
    return emptyPayload;
  }
}

function writeEncryptedUsers(payload) {
  ensureStorage();
  fs.writeFileSync(USERS_FILE, encryptJson(payload));
}

function readAvailabilities() {
  ensureStorage();
  const raw = fs.readFileSync(AVAILABILITIES_FILE, 'utf8');
  const payload = JSON.parse(raw);
  return Array.isArray(payload.availabilities) ? payload.availabilities : [];
}

function writeAvailabilities(availabilities) {
  ensureStorage();
  fs.writeFileSync(AVAILABILITIES_FILE, JSON.stringify({ availabilities }, null, 2));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return PASSWORD_PREFIX + salt + '$' + derived;
}

function comparePassword(password, storedHash) {
  if (!storedHash || !storedHash.startsWith(PASSWORD_PREFIX)) {
    return false;
  }

  const parts = storedHash.split('$');
  const salt = parts[1];
  const expected = parts[2];
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');

  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    apartment: user.apartment,
    phone: user.phone
  };
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function generateId(prefix) {
  return prefix + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
}

function syncAvailabilityStatuses(availabilities) {
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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  fs.readFile(filePath, function (error, content) {
    if (error) {
      sendJson(res, 404, { message: 'Arquivo não encontrado.' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
    });
    res.end(content);
  });
}

function parseRequestBody(req) {
  return new Promise(function (resolve, reject) {
    let body = '';

    req.on('data', function (chunk) {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Payload muito grande.'));
        req.destroy();
      }
    });

    req.on('end', function () {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, {
      sessionStorageKey: SESSION_STORAGE_KEY,
      status: STATUS,
      storage: {
        usersFile: '/data/users.db.enc',
        encrypted: true,
        algorithm: 'aes-256-cbc'
      },
      passwordHashAlgorithm: 'scrypt'
    });
    return true;
  }

  if (pathname === '/api/signup' && req.method === 'POST') {
    const body = await parseRequestBody(req);
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
    const body = await parseRequestBody(req);
    const phone = normalizePhone(body.phone);
    const password = String(body.password || '');
    const storage = readEncryptedUsers();

    const user = storage.users.find(function (item) {
      return item.phone === phone;
    });

    if (!user || !comparePassword(password, user.passwordHash)) {
      sendJson(res, 401, { message: 'Telefone ou senha inválidos.' });
      return true;
    }

    sendJson(res, 200, { user: sanitizeUser(user) });
    return true;
  }

  if (pathname === '/api/availabilities' && req.method === 'GET') {
    const users = readEncryptedUsers().users;
    const availabilities = syncAvailabilityStatuses(readAvailabilities()).map(function (availability) {
      const owner = users.find(function (user) { return user.id === availability.ownerId; });
      return Object.assign({}, availability, {
        owner: owner ? sanitizeUser(owner) : null
      });
    });

    sendJson(res, 200, { availabilities: availabilities });
    return true;
  }

  if (pathname === '/api/availabilities' && req.method === 'POST') {
    const body = await parseRequestBody(req);
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
      ownerId: owner.id,
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      status: STATUS.AVAILABLE
    };

    availabilities.push(availability);
    writeAvailabilities(availabilities);

    sendJson(res, 201, {
      availability: Object.assign({}, availability, { owner: sanitizeUser(owner) })
    });
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

    const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.resolve(ROOT, '.' + requestPath);

    if (!filePath.startsWith(ROOT)) {
      sendJson(res, 403, { message: 'Acesso negado.' });
      return;
    }

    sendFile(res, filePath);
  } catch (error) {
    sendJson(res, 500, { message: 'Erro interno.', error: error.message });
  }
});

ensureStorage();
server.listen(PORT, function () {
  console.log('[CondoPark] Rodando em http://localhost:' + PORT);
});
