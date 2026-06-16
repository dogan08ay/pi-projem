export default async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const { paymentId, action, txid } = req.body;

  const APP_SECRET = process.env.APP_SECRET;

  try {

    let piResponse;

    if (action === "approve") {

      piResponse = await fetch(
        `https://api.minepi.com/v2/payments/${paymentId}/approve`,
        {
          method: "POST",
          headers: {
            Authorization: `Key ${APP_SECRET}`,
            "Content-Type": "application/json"
          }
        }
      );

    } else if (action === "complete") {

      piResponse = await fetch(
        `https://api.minepi.com/v2/payments/${paymentId}/complete`,
        {
          method: "POST",
          headers: {
            Authorization: `Key ${APP_SECRET}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            txid
          })
        }
      );

    } else {

      return res.status(400).json({
        error: "Invalid action"
      });

    }

    const data = await piResponse.json();

    if (!piResponse.ok) {

      console.error(
        "PI ERROR:",
        data
      );

      return res.status(piResponse.status)
        .json(data);

    }

    return res.status(200).json(data);

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message
    });

  }

}
