export default async function handler(req, res) {
    // CORS ayarları (Pi Browser'ın sunucuya erişebilmesi için zorunlu)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Yalnızca POST istekleri kabul edilir' });
    }

    const { paymentId, action, txid } = req.body;
    
    // Sizin ürettiğiniz orijinal Sandbox API Anahtarınız buraya yerleştirildi
    const apiKey = "fdolemqtquahyy662hba2vmps38mrerzetumrpqz8uqchinoazsagnk7hqevvcqa"; 

    try {
        const url = `https://api.minepi.com/v2/payments/${paymentId}/${action}`;
        const bodyData = action === 'complete' ? JSON.stringify({ txid: txid }) : JSON.stringify({});

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Key ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: bodyData
        });

        const data = await response.json();
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
