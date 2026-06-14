import axios from "axios";

const PI_API_KEY = process.env.PI_API_KEY;

export default async function handler(req, res) {

    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method not allowed"
        });
    }

    try {

        const { paymentId, txid } = req.body;

        const result = await axios.post(
            `https://api.minepi.com/v2/payments/${paymentId}/complete`,
            {
                txid: txid
            },
            {
                headers: {
                    Authorization: `Key ${PI_API_KEY}`
                }
            }
        );

        res.status(200).json(result.data);

    } catch(err) {

        console.error(err.response?.data || err.message);

        res.status(500).json({
            error: err.response?.data || err.message
        });

    }

}
