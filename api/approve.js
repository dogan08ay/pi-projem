export default async function handler(req, res) {

    if (req.method !== 'POST') {

        return res.status(405).json({
            error: 'Method not allowed'
        });

    }

    try {

        const {
            paymentId,
            action,
            txid
        } = req.body;

        let url = '';

        let body = {};

        if (action === 'approve') {

            url = `https://api.minepi.com/v2/payments/${paymentId}/approve`;

        }

        if (action === 'complete') {

            url = `https://api.minepi.com/v2/payments/${paymentId}/complete`;

            body = {
                txid: txid
            };

        }

        const response = await fetch(

            url,

            {

                method: 'POST',

                headers: {

                    Authorization: `Key ${process.env.PI_API_KEY}`,

                    'Content-Type': 'application/json'

                },

                body: action === 'complete'
                    ? JSON.stringify(body)
                    : undefined

            }

        );

        const data = await response.json();

        return res.status(200).json(data);

    } catch (error) {

        return res.status(500).json({

            error: error.message

        });

    }

}
