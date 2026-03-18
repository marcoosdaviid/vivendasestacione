import { kv } from '@vercel/kv';

export default async function handler(req, res) {
    const USERS_KEY = 'condopark_users';

    // Defensive check for KV environment variables
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
        console.error('Missing Vercel KV environment variables');
        return res.status(500).json({
            error: 'Vercel KV não configurado.',
            details: 'Conecte o Storage KV no painel do Vercel e faça um novo Deploy.'
        });
    }

    try {
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
    } catch (error) {
        console.error('KV Error:', error);
        return res.status(500).json({ error: 'Erro de conexão com o Vercel KV', details: error.message });
    }
}
