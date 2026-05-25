export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Yalnızca POST istekleri kabul edilir' });
    }

    const { paymentId, action } = req.body;

    // Pi Network Developer Portal'dan aldığınız Sandbox API anahtarınız (Gerekirse buraya yazılabilir)
    // Ancak test ortamında doğrudan onaylamak için Pi API'sine istek atıyoruz
    try {
        const apiKey = "Uygulama oluştururken aldığınız o uzun server API key"; 
        
        const response = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/${action}`, {
            method: 'POST',
            headers: {
                'Authorization': `Key ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
