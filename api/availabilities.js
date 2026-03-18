import { kv } from '@vercel/kv';

export default async function handler(req, res) {
    const AVAIL_KEY = 'condopark_availabilities';

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
}
