import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
    
    if (!NOWPAYMENTS_IPN_SECRET) {
      console.error('NOWPAYMENTS_IPN_SECRET not configured');
      return res.status(500).json({ error: 'IPN secret not configured' });
    }

    // Get the raw body for signature verification
    // Note: In serverless functions, body is already parsed, so we stringify it
    // For proper signature verification, ensure the order of keys matches what NOWPayments sends
    const rawBody = JSON.stringify(req.body);
    const signature = req.headers['x-nowpayments-sig'] || req.headers['x-nowpayments-signature'];

    if (!signature) {
      return res.status(400).json({ error: 'Missing signature' });
    }

    // Verify the signature
    const expectedSignature = crypto
      .createHmac('sha512', NOWPAYMENTS_IPN_SECRET)
      .update(rawBody)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.error('Invalid IPN signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const paymentData = req.body;

    // Extract tracking ID from order_id (format: tracking-{trackingId}-{timestamp})
    const orderId = paymentData.order_id || '';
    const trackingIdMatch = orderId.match(/^tracking-(.+?)-/);
    const trackingId = trackingIdMatch ? trackingIdMatch[1] : null;

    console.log('IPN received:', {
      paymentId: paymentData.payment_id,
      paymentStatus: paymentData.payment_status,
      orderId: paymentData.order_id,
      trackingId: trackingId,
      payAmount: paymentData.pay_amount,
      payCurrency: paymentData.pay_currency
    });

    // Handle different payment statuses
    const status = paymentData.payment_status;
    
    // Status values: waiting, confirming, confirmed, sending, partially_paid, finished, failed, refunded, expired
    if (status === 'finished') {
      // Payment completed successfully
      // You can update your database here, send confirmation emails, etc.
      console.log(`Payment ${paymentData.payment_id} completed for tracking ${trackingId}`);
    } else if (status === 'failed' || status === 'expired') {
      // Payment failed or expired
      console.log(`Payment ${paymentData.payment_id} ${status} for tracking ${trackingId}`);
    } else if (status === 'partially_paid') {
      // Partial payment received
      console.log(`Payment ${paymentData.payment_id} partially paid for tracking ${trackingId}`);
    }

    // Always return 200 OK to acknowledge receipt
    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('IPN processing error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

