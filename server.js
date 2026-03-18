const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 4173;

app.use(express.json());

// Log all requests
app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});

app.use(express.static(__dirname));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const AVAILABILITIES_FILE = path.join(DATA_DIR, 'availabilities.json');

console.log('Users file:', USERS_FILE);
console.log('Availabilities file:', AVAILABILITIES_FILE);

// Helper to read JSON file
const readJSON = (filePath) => {
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return [];
    }
};

// Helper to write JSON file
const writeJSON = (filePath, data) => {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
};

// API Endpoints
app.get('/api/users', (req, res) => {
    res.json(readJSON(USERS_FILE));
});

app.post('/api/users', (req, res) => {
    const users = readJSON(USERS_FILE);
    const newUser = req.body;

    if (users.some(u => u.phone === newUser.phone)) {
        return res.status(400).json({ error: 'User already exists' });
    }

    users.push(newUser);
    writeJSON(USERS_FILE, users);
    res.status(201).json(newUser);
});

app.get('/api/availabilities', (req, res) => {
    res.json(readJSON(AVAILABILITIES_FILE));
});

app.post('/api/availabilities', (req, res) => {
    const availabilities = req.body;
    writeJSON(AVAILABILITIES_FILE, availabilities);
    res.status(200).json({ message: 'Saved successfully' });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).json({ error: 'Erro interno no servidor', details: err.message });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
