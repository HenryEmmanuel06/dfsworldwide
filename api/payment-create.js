import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Try to load dotenv if available (for local development)
  try { 
    await import('dotenv/config'); 
  } catch (_) {
    // dotenv not available or already loaded - this is fine for serverless
  }

  try {
    const { trackingId, currency, amount, currencyType } = req.body;

    if (!trackingId || !currency || !amount || !currencyType) {
      return res.status(400).json({ error: 'Missing required fields: trackingId, currency, amount, currencyType' });
    }

    // Validate currency is one of the supported crypto currencies
    const supportedCurrencies = ['BTC', 'ETH', 'BNB'];
    if (!supportedCurrencies.includes(currency)) {
      return res.status(400).json({ error: 'Unsupported currency. Supported: BTC, ETH, BNB' });
    }

    const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
    const NOWPAYMENTS_BASE_URL = process.env.NOWPAYMENTS_BASE_URL || 'https://api-sandbox.nowpayments.io/v1';

    if (!NOWPAYMENTS_API_KEY) {
      return res.status(500).json({ error: 'Payment service not configured' });
    }

    // Get base URL from environment or headers
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 
                    req.headers['x-forwarded-host'] ? 
                      `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host']}` :
                      req.headers.origin || 
                      'https://dfsworldwide.vercel.app';

    // Format amount properly (NOWPayments expects numeric value)
    const priceAmount = parseFloat(amount);
    if (isNaN(priceAmount) || priceAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount. Must be a positive number.' });
    }

    // NOWPayments expects lowercase currency codes
    const payCurrency = currency.toLowerCase(); // btc, eth, bnb

    // Create payment request to NOWPayments
    const paymentData = {
      price_amount: priceAmount,
      price_currency: (currencyType || 'USD').toLowerCase(), // usd, eur, etc.
      pay_currency: payCurrency, // btc, eth, bnb (lowercase)
      order_id: `tracking-${trackingId}-${Date.now()}`,
      order_description: `Payment for shipment tracking: ${trackingId}`,
      ipn_callback_url: `${baseUrl}/api/payment-ipn`,
      success_url: `${baseUrl}/payment?status=success&tid=${trackingId}`,
      cancel_url: `${baseUrl}/payment?status=cancelled&tid=${trackingId}`
    };

    console.log('Creating payment with NOWPayments:', {
      url: `${NOWPAYMENTS_BASE_URL}/payment`,
      data: paymentData
    });

    const response = await fetch(`${NOWPAYMENTS_BASE_URL}/payment`, {
      method: 'POST',
      headers: {
        'x-api-key': NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(paymentData)
    });

    console.log('NOWPayments response status:', response.status, response.statusText);

    let data;
    const responseText = await response.text();
    
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch (parseError) {
      console.error('Failed to parse NOWPayments response:', {
        error: parseError.message,
        rawResponse: responseText.substring(0, 500), // Log first 500 chars
        status: response.status,
        statusText: response.statusText
      });
      return res.status(500).json({ 
        error: 'Invalid response from payment service',
        details: 'Could not parse response. Check console for raw response.',
        rawResponse: responseText.substring(0, 200)
      });
    }

    console.log('NOWPayments API response:', {
      status: response.status,
      statusText: response.statusText,
      data: data
    });

    if (!response.ok) {
      console.error('NOWPayments API error:', {
        status: response.status,
        statusText: response.statusText,
        data: data
      });
      
      const errorMessage = data.message || data.error || data.description || 'Payment creation failed';
      return res.status(response.status || 500).json({ 
        error: errorMessage,
        details: data,
        statusCode: response.status
      });
    }

    // Handle different possible response structures from NOWPayments
    // NOWPayments API can return different formats, check all possible locations
    // Response might be directly in data or nested in a result/response field
    let responseData = data;
    
    // Check if response is nested (some APIs wrap it)
    if (data.result && typeof data.result === 'object') {
      responseData = data.result;
    } else if (data.data && typeof data.data === 'object') {
      responseData = data.data;
    } else if (data.response && typeof data.response === 'object') {
      responseData = data.response;
    }

    // Try all possible field name variations for payment URL
    const paymentUrl = responseData.pay_url || 
                       responseData.invoice_url || 
                       responseData.payment_url || 
                       responseData.url || 
                       responseData.invoiceUrl ||
                       responseData.payUrl ||
                       responseData.link ||
                       responseData.checkout_url ||
                       responseData.checkoutUrl ||
                       (data.pay_url || data.invoice_url || data.payment_url);

    // Try all possible field name variations for payment ID
    const paymentId = responseData.payment_id || 
                      responseData.id || 
                      responseData.paymentId ||
                      responseData.invoice_id ||
                      (data.payment_id || data.id);

    // Try all possible field name variations for amount
    const payAmount = responseData.pay_amount || 
                      responseData.amount || 
                      responseData.price_amount ||
                      (data.pay_amount || data.amount);

    // Try all possible field name variations for currency
    const responsePayCurrency = responseData.pay_currency || 
                        responseData.currency || 
                        responseData.payCurrency ||
                                 (data.pay_currency || data.currency) ||
                                 payCurrency; // Fallback to the currency we sent

    // Extract wallet address (payment address)
    const walletAddress = responseData.payment_address || 
                          responseData.pay_address ||
                          responseData.address ||
                          responseData.wallet_address ||
                          (data.payment_address || data.pay_address || data.address);

    // Extract expiration time - NOWPayments may return it in various formats
    let expirationTime = responseData.expiration_estimate_at ||
                           responseData.expires_at ||
                           responseData.expiration_at ||
                           responseData.expires_at_iso ||
                           responseData.expiration_estimate ||
                           responseData.expires ||
                           (data.expiration_estimate_at || 
                            data.expires_at || 
                            data.expiration_at ||
                            data.expiration_estimate ||
                            data.expires);
    
    // If no expiration time provided, set a default (30 minutes from now)
    if (!expirationTime) {
      const defaultExpiration = new Date();
      defaultExpiration.setMinutes(defaultExpiration.getMinutes() + 30);
      expirationTime = defaultExpiration.toISOString();
      console.log('No expiration time from NOWPayments, using default 30 minutes:', expirationTime);
    }
    
    // Log expiration time for debugging
    console.log('Expiration time extracted:', {
      expirationTime,
      type: typeof expirationTime,
      allExpirationFields: {
        expiration_estimate_at: responseData.expiration_estimate_at,
        expires_at: responseData.expires_at,
        expiration_at: responseData.expiration_at,
        expires_at_iso: responseData.expires_at_iso
      }
    });

    console.log('Extracted payment data:', {
      paymentId,
      paymentUrl: paymentUrl ? 'present' : 'missing',
      payAmount,
      payCurrency: responsePayCurrency,
      walletAddress: walletAddress ? 'present' : 'missing',
      expirationTime: expirationTime || 'not provided',
      allKeys: Object.keys(responseData),
      fullResponse: JSON.stringify(responseData, null, 2)
    });

    // For displaying payment details, we need wallet address
    // Payment URL is optional if we're displaying wallet address
    if (!walletAddress && !paymentUrl) {
      console.error('Missing payment URL and wallet address in response. Full response structure:', JSON.stringify(data, null, 2));
      console.error('Response data keys:', Object.keys(responseData || {}));
      
      // Return the full response so user can see what was actually returned
      return res.status(500).json({
        error: 'Payment details not received from payment service',
        details: 'The payment service did not return payment details. Please check your API configuration.',
        debug: {
          receivedKeys: Object.keys(responseData || {}),
          fullResponse: responseData,
          suggestion: 'Check server logs for the complete NOWPayments API response'
        }
      });
    }

    // Save payment to database (non-blocking with timeout)
    // Don't block payment creation if database save fails
    const saveToDatabase = async () => {
      try {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
        const usingServiceRole = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        console.log('Supabase configuration:', {
          url: supabaseUrl ? 'configured' : 'missing',
          keyType: usingServiceRole ? 'SERVICE_ROLE_KEY' : 'ANON_KEY',
          keyPresent: !!supabaseKey,
          note: usingServiceRole ? 'Service role bypasses RLS' : 'ANON_KEY requires RLS policies'
        });
        
        if (!supabaseUrl || !supabaseKey) {
          console.warn('Supabase credentials not configured, skipping database save');
          return { success: false, error: 'Supabase not configured' };
        }

        // Create Supabase client
        const supabase = createClient(supabaseUrl, supabaseKey, {
          db: { schema: 'public' },
          auth: { persistSession: false }
        });
        
        // Parse expiration time - NOWPayments returns ISO string or Unix timestamp
        let expirationDateTime = null;
        if (expirationTime) {
          // Try parsing as ISO string first
          let parsedDate = new Date(expirationTime);
          
          // If invalid, try as Unix timestamp (seconds or milliseconds)
          if (isNaN(parsedDate.getTime())) {
            const unixTime = typeof expirationTime === 'number' 
              ? expirationTime 
              : parseInt(expirationTime);
            
            if (!isNaN(unixTime)) {
              // Check if it's in seconds (10 digits) or milliseconds (13 digits)
              parsedDate = unixTime < 10000000000 
                ? new Date(unixTime * 1000) 
                : new Date(unixTime);
            }
          }
          
          if (!isNaN(parsedDate.getTime())) {
            expirationDateTime = parsedDate.toISOString();
          } else {
            console.warn('Could not parse expiration time:', expirationTime);
          }
        }

        const orderId = paymentData.order_id;
        // Extract full tracking ID from order_id format: tracking-{trackingId}-{timestamp}
        // Example: tracking-DFS-202512131921-XZCBCL-1736773039675
        // We need to match everything between "tracking-" and the last "-" followed by digits
        let extractedTrackingId = trackingId; // Default to the trackingId from request
        
        if (orderId && orderId.startsWith('tracking-')) {
          // Remove "tracking-" prefix
          const withoutPrefix = orderId.substring(9); // "tracking-".length = 9
          // Find the last occurrence of "-" followed by digits (timestamp)
          const lastDashIndex = withoutPrefix.lastIndexOf('-');
          if (lastDashIndex > 0) {
            // Check if what follows the last dash is a timestamp (all digits)
            const afterLastDash = withoutPrefix.substring(lastDashIndex + 1);
            if (/^\d+$/.test(afterLastDash)) {
              // Extract everything before the last dash (this is the full tracking ID)
              extractedTrackingId = withoutPrefix.substring(0, lastDashIndex);
            }
          }
        }
        
        // Use extracted tracking ID or fallback to the one from request
        const finalTrackingId = extractedTrackingId || trackingId;
        
        console.log('Tracking ID extraction:', {
          orderId: orderId,
          requestTrackingId: trackingId,
          extractedTrackingId: extractedTrackingId,
          finalTrackingId: finalTrackingId
        });

        // Validate required fields before insert
        if (!paymentId) {
          throw new Error('Payment ID is required but not provided by NOWPayments');
        }
        if (!orderId) {
          throw new Error('Order ID is required');
        }
        if (!finalTrackingId) {
          throw new Error('Tracking ID is required');
        }
        if (!priceAmount || isNaN(priceAmount)) {
          throw new Error('Valid price amount is required');
        }
        if (!responsePayCurrency) {
          throw new Error('Payment currency is required');
        }

        // Prepare payment record with correct data types matching PostgreSQL schema
        const paymentRecord = {
          payment_id: String(paymentId), // VARCHAR(255) NOT NULL
          order_id: String(orderId), // VARCHAR(255) NOT NULL
          tracking_id: String(finalTrackingId), // TEXT NOT NULL - full tracking ID like DFS-202512131921-XZCBCL
          price_amount: parseFloat(priceAmount), // DECIMAL(20, 8) NOT NULL - pass as number
          price_currency: String((currencyType || 'USD').toLowerCase()), // VARCHAR(10) NOT NULL DEFAULT 'USD'
          pay_amount: payAmount ? parseFloat(payAmount) : null, // DECIMAL(20, 8) - pass as number or null
          pay_currency: String(responsePayCurrency), // VARCHAR(10) NOT NULL
          wallet_address: walletAddress ? String(walletAddress) : null, // VARCHAR(255)
          payment_address: walletAddress ? String(walletAddress) : null, // VARCHAR(255)
          payment_status: 'waiting', // VARCHAR(50) DEFAULT 'waiting'
          payment_url: paymentUrl ? String(paymentUrl) : null, // TEXT
          invoice_url: paymentUrl ? String(paymentUrl) : null, // TEXT
          expiration_time: expirationDateTime || null, // TIMESTAMP - ISO string format
          expiration_estimate_at: expirationDateTime || null, // TIMESTAMP - ISO string format
          raw_response: data || null, // JSONB - Supabase automatically serializes objects
          ipn_received: false, // BOOLEAN DEFAULT FALSE
          ipn_received_at: null, // TIMESTAMP
          ipn_data: null // JSONB
        };

        console.log('Attempting to insert payment record:', {
          payment_id: paymentRecord.payment_id,
          order_id: paymentRecord.order_id,
          tracking_id: paymentRecord.tracking_id,
          tracking_id_length: paymentRecord.tracking_id?.length,
          price_amount: paymentRecord.price_amount,
          pay_amount: paymentRecord.pay_amount,
          pay_currency: paymentRecord.pay_currency,
          has_wallet_address: !!paymentRecord.wallet_address,
          expiration_time: paymentRecord.expiration_time,
          payment_status: paymentRecord.payment_status
        });

        // Insert payment record with detailed error handling
        console.log('Executing Supabase insert...');
        const { data: insertData, error: insertError } = await supabase
          .from('payments')
          .insert(paymentRecord)
          .select(); // Add select to get response and verify insert
        
        console.log('Supabase insert response received:', {
          hasError: !!insertError,
          hasData: !!insertData,
          dataLength: insertData?.length,
          errorType: insertError?.constructor?.name,
          fullError: insertError
        });

        if (insertError) {
          console.error('❌ Database insert error:', {
            message: insertError.message,
            details: insertError.details,
            hint: insertError.hint,
            code: insertError.code,
            fullError: JSON.stringify(insertError, Object.getOwnPropertyNames(insertError))
          });
          
          // Check for common issues
          if (insertError.code === '23505') {
            console.error('Duplicate key error - payment_id already exists:', paymentRecord.payment_id);
          } else if (insertError.code === '42501') {
            console.error('Permission denied - check RLS policies');
          } else if (insertError.code === '42P01') {
            console.error('Table does not exist - check table name');
          }
          
          return { 
            success: false, 
            error: insertError.message,
            details: insertError.details,
            hint: insertError.hint,
            code: insertError.code
          };
        }

        if (insertData && insertData.length > 0) {
          console.log('✅ Payment saved to database successfully!', {
            insertedId: insertData[0].id,
            paymentId: insertData[0].payment_id,
            trackingId: insertData[0].tracking_id,
            fullRecord: insertData[0]
          });
          return { success: true, insertedId: insertData[0].id, data: insertData[0] };
        } else {
          console.warn('⚠️ Database insert returned no data - insert may have failed silently');
          console.warn('Check RLS policies, table permissions, and constraints');
          return { success: false, error: 'Insert completed but no data returned - check RLS policies' };
        }
      } catch (dbException) {
        console.error('Database save exception:', dbException);
        return { success: false, error: dbException.message || 'Unknown database error' };
      }
    };

    // Start database save - temporarily blocking to debug insert issues
    // TODO: Make non-blocking again once insert is working
    let dbSaveResult = null;
    try {
      console.log('Starting database save (blocking mode for debugging)...');
      dbSaveResult = await saveToDatabase();
      console.log('Database save completed:', dbSaveResult);
    } catch (err) {
      console.error('Failed to save to database:', {
        error: err.message,
        stack: err.stack,
        name: err.name
      });
      dbSaveResult = { success: false, error: err.message };
    }

    // Return payment response immediately (don't wait for DB save)
    const paymentResponse = {
      success: true,
      payment: responseData,
      paymentId: paymentId,
      paymentUrl: paymentUrl,
      payAmount: payAmount,
      payCurrency: responsePayCurrency,
      walletAddress: walletAddress,
      expirationTime: expirationTime,
      rawResponse: data // Include raw response for debugging
    };

    // Log database save result (now blocking, so we can see errors immediately)
    if (dbSaveResult) {
      if (dbSaveResult.success) {
        console.log('✅ Payment saved to database successfully:', {
          paymentId: paymentId,
          insertedId: dbSaveResult.insertedId
        });
      } else {
        console.error('❌ Database save failed:', {
          paymentId: paymentId,
          error: dbSaveResult.error,
          details: dbSaveResult.details,
          hint: dbSaveResult.hint,
          code: dbSaveResult.code
        });
        
        // If RLS is the issue, provide helpful message
        if (dbSaveResult.code === '42501' || dbSaveResult.hint?.includes('RLS')) {
          console.error('💡 RLS Policy Issue: Row Level Security is blocking the insert.');
          console.error('💡 Solution: Disable RLS on payments table or create an INSERT policy.');
          console.error('💡 Run: ALTER TABLE payments DISABLE ROW LEVEL SECURITY;');
        }
      }
    }

    return res.status(200).json(paymentResponse);

  } catch (error) {
    console.error('Payment creation error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}

