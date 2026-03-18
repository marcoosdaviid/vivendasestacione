import { kv } from '@vercel/kv';

export default async function handler(req, res) {
    const AVAIL_KEY = 'condopark_availabilities';

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
            const avail = await kv.get(AVAIL_KEY);
            return res.status(200).json(avail || []);
        }

        if (req.method === 'POST') {
            const availabilities = req.body;
            await kv.set(AVAIL_KEY, availabilities);
            return res.status(200).json({ message: 'Success' });
        }

        return res.status(405).json({ error: 'Method Not Allowed' });
    } catch (error) {
        console.error('KV Error:', error);
        return res.status(500).json({ error: 'Erro de conexão com o Vercel KV', details: error.message });
    }
}
