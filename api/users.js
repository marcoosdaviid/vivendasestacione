import { kv } from '@vercel/kv';

export default async function handler(req, res) {
    const USERS_KEY = 'condopark_users';

    if (req.method === 'GET') {
        const users = await kv.get(USERS_KEY);
        return res.status(200).json(users || []);
    }

    if (req.method === 'POST') {
        const newUser = req.body;
        let users = await kv.get(USERS_KEY) || [];

        if (users.some(u => u.phone === newUser.phone)) {
            return res.status(400).json({ error: 'Telefone já cadastrado!' });
        }

        users.push(newUser);
        await kv.set(USERS_KEY, users);
        return res.status(201).json(newUser);
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
}
