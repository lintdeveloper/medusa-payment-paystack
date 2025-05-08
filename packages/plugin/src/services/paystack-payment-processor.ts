import crypto from "crypto";

import Paystack from "../lib/paystack";

import {
  MedusaContainer,
  WebhookActionResult,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  UpdatePaymentInput,
  AuthorizePaymentOutput,
  AuthorizePaymentInput,
  CapturePaymentInput,
  CapturePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  UpdatePaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  RefundPaymentInput,
  RefundPaymentOutput,
} from "@medusajs/framework/types";
import {
  MedusaError,
  PaymentSessionStatus,
  AbstractPaymentProvider,
  PaymentActions,
} from "@medusajs/framework/utils";
import { formatCurrencyCode } from "../utils/currencyCode";

export interface PaystackPaymentProcessorConfig
  extends Record<string, unknown> {
  /**
   * Paystack Secret Key
   *
   * Should be in the format sk_test-... or sk_live-...
   *
   * Obtainable from the Paystack dashboard - Settings -> API Keys & Webhooks
   *
   * https://dashboard.paystack.com/#/settings/developers
   */
  secret_key: string;

  /**
   * Disable retries on network errors and 5xx errors on idempotent requests to Paystack
   *
   * Generally, you should not disable retries, these errors are usually temporary
   * but it can be useful for debugging
   * @default false
   */
  disable_retries?: boolean;

  /**
   * Debug mode
   * If true, logs helpful debug information to the console
   * Logs are prefixed with "PS_P_Debug"
   */
  debug?: boolean;
}

type PaystackPaymentProviderSessionResponse = InitiatePaymentOutput & {
  data: {
    paystackTxRef: string;
    paystackTxAccessCode: string;
    paystackTxAuthorizationUrl: string;
  };
};

export class PaymentProviderError extends MedusaError {
  constructor(message: string, cause?: unknown, code?: string, detail?: string) {
    super(
      MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR,
      message,
    );

    this.name = "PaymentProviderError";
  }
}


class PaystackPaymentProcessor extends AbstractPaymentProvider {
  static identifier = "paystack";

  protected readonly configuration: PaystackPaymentProcessorConfig;
  protected readonly paystack: Paystack;
  protected readonly debug: boolean;

  constructor(
    container: Record<string, any> & MedusaContainer,
    options: PaystackPaymentProcessorConfig,
  ) {
    super(container, options);

    if (!options.secret_key) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        "The Paystack provider requires the secret_key option",
      );
    }

    this.configuration = options;
    this.paystack = new Paystack(this.configuration.secret_key, {
      disable_retries: options.disable_retries,
    });
    this.debug = Boolean(options.debug);
  }

  /**
   * Called when a user selects Paystack as their payment method during checkout
   */
  async initiatePayment(
    initiatePaymentData: InitiatePaymentInput,
  ): Promise<PaystackPaymentProviderSessionResponse> {
    if (this.debug) {
      console.info(
        "PS_P_Debug: InitiatePayment",
        JSON.stringify(initiatePaymentData, null, 2),
      );
    }

    const { data, amount, currency_code } = initiatePaymentData;
    const email = data?.email as string | undefined;
    const session_id = data?.session_id as string | undefined;

    const validatedCurrencyCode = formatCurrencyCode(currency_code);

    if (!email) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
       "Email is required to initiate a Paystack payment. Ensure you are providing the email in the context object when calling `initiatePaymentSession` in your Medusa storefront",
      )
    }

    try {
      const { data, status, message } =
        await this.paystack.transaction.initialize({
          amount: Number(amount) * 100, // Paystack expects amount in lowest denomination - https://paystack.com/docs/api/#supported-currency
          email,
          currency: validatedCurrencyCode,
          metadata: {
            session_id,
          },
        });

      if (status === false) {
        throw this.buildError("Failed to initiate Paystack payment", {
          detail: message,
        });
      }

      return {
        id: data.reference,
        data: {
          paystackTxRef: data.reference,
          paystackTxAccessCode: data.access_code,
          paystackTxAuthorizationUrl: data.authorization_url,
        },
      };
    } catch (error) {
      if (this.debug) {
        console.error("PS_P_Debug: InitiatePayment: Error", error);
      }

      throw this.buildError("Failed to initiate Paystack payment", error);
    }
  }

  /**
   * Called when a cart item is added or shipping address is updated
   */
  async updatePayment(
    input: UpdatePaymentInput,
  ): Promise<UpdatePaymentOutput> {
    if (this.debug) {
      console.info(
        "PS_P_Debug: UpdatePayment",
        JSON.stringify(input, null, 2),
      );
    }

    // Paystack does not support updating transactions
    // We abandon the current transaction and create a new one instead
    return this.initiatePayment(input);
  }

  /**
   * Called when a cart is completed
   * We validate the payment and return a status
   */
  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    if (this.debug) {
      console.info(
        "PS_P_Debug: AuthorizePayment",
        JSON.stringify(input, null, 2),
      );
    }

    const paystackTxRef = input.data?.paystackTxRef as string | undefined;

    if (!paystackTxRef) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
       "Provide a paystackTxRef to authorize payment. Ensure you are providing the paystackTxRef in the context object when calling `authorizePaymentSession` in your Medusa storefront",
      )
    }

    try {

      const { status, data } = await this.paystack.transaction.verify({
        reference: paystackTxRef,
      });

      if (this.debug) {
        console.info(
          "PS_P_Debug: AuthorizePayment: Verification",
          JSON.stringify({ status, data }, null, 2),
        );
      }

      if (status === false) {
        // Invalid key error
        return {
          status: PaymentSessionStatus.ERROR,
          data: {
            data, paystackTxId: null,
            paystackTxData: data,
          },
        };
      }

      switch (data.status) {
        case "success": {
          // Successful transaction
          return {
            // Captured instead of authorized so they are automatically captured
            status: PaymentSessionStatus.CAPTURED,
            data: {
              paystackTxId: data.id,
              paystackTxData: data,
            },
          };
        }

        case "failed":
          // Failed transaction
          return {
            status: PaymentSessionStatus.ERROR,
            data: {
              ...input,
              paystackTxId: data.id,
              paystackTxData: data,
            },
          };

        default:
          // Pending transaction
          return {
            status: PaymentSessionStatus.PENDING,
            data: input,
          };
      }
    } catch (error) {
      if (this.debug) {
        console.error("PS_P_Debug: AuthorizePayment: Error", error);
      }
      throw this.buildError("Failed to authorize payment", error);
    }
  }

  /**
   * Retrieve transaction data from Paystack.
   */
  async retrievePayment(
    paymentSessionData: RetrievePaymentInput,
  ): Promise<RetrievePaymentOutput> {
    if (this.debug) {
      console.info(
        "PS_P_Debug: RetrievePayment",
        JSON.stringify(paymentSessionData, null, 2),
      );
    }

    const paystackTxId = paymentSessionData.data?.id as string ;

    try {
      const { data, status, message } = await this.paystack.transaction.get({
        id: paystackTxId,
      });

      if (status === false) {
        throw this.buildError("Failed to retrieve payment", {
          detail: message,
        });
      }

      return {
        data
      };
    } catch (error) {
      if (this.debug) {
        console.error("PS_P_Debug: RetrievePayment: Error", error);
      }

      throw this.buildError("Failed to retrieve payment", error);
    }
  }

  /**
   * Refunds payment for Paystack transaction
   */
  async refundPayment(
    paymentSessionData: RefundPaymentInput
  ): Promise<RefundPaymentOutput> {
    if (this.debug) {
      console.info(
        "PS_P_Debug: RefundPayment",
        JSON.stringify({ paymentSessionData }, null, 2),
      );
    }

    try {
      const paystackTxId = Number(paymentSessionData.data?.id as string);
      // Amount to refund
      const { amount } = paymentSessionData;

      const { data, status, message } = await this.paystack.refund.create({
        transaction: paystackTxId,
        amount: Number(amount) * 100,
      });

      if (status === false) {
        throw this.buildError("Failed to refund payment", {
          detail: message,
        });
      }

      return { data };
    } catch (error) {
      if (this.debug) {
        console.error("PS_P_Debug: RefundPayment: Error", error);
      }

      throw this.buildError("Failed to refund payment", error);
    }
  }

  /**
   * Returns Paystack transaction status
   */
  async getPaymentStatus(
    paymentSessionData: GetPaymentStatusInput,
  ): Promise<GetPaymentStatusOutput> {
    if (this.debug) {
      console.info(
        "PS_P_Debug: GetPaymentStatus",
        JSON.stringify(paymentSessionData, null, 2),
      );
    }

    const paystackTxId = paymentSessionData.data?.id as string;
    if (!paystackTxId) {
      return {status: PaymentSessionStatus.PENDING};
    }

    try {
      const { data, status } = await this.paystack.transaction.get({
        id: paystackTxId,
      });

      if (this.debug) {
        console.info(
          "PS_P_Debug: GetPaymentStatus: Verification",
          JSON.stringify({ status, data }, null, 2),
        );
      }

      if (status === false) {
        return {status: PaymentSessionStatus.ERROR};
      }

      switch (data?.status) {
        case "success":
          return {status: PaymentSessionStatus.AUTHORIZED};
        case "failed":
          return {status: PaymentSessionStatus.ERROR};
        default:
          return {status: PaymentSessionStatus.PENDING};
      }
    } catch (error) {
      if (this.debug) {
        console.error("PS_P_Debug: GetPaymentStatus: Error", error);
      }

      throw this.buildError("Failed to get payment status", error);
    }
  }

  /**
   * Handles incoming webhook events from Paystack
   */
  async getWebhookActionAndData({
    data: { event, data },
    rawData,
    headers,
  }: {
    data: {
      event: string;
      data: {
        amount: number;
        metadata?: Record<string, any>;
      };
    };
    rawData: string | Buffer;
    headers: Record<string, unknown>;
  }): Promise<WebhookActionResult> {
    if (this.debug) {
      console.info(
        "PS_P_Debug: Handling webhook event",
        JSON.stringify({ data, headers }, null, 2),
      );
    }

    const webhookSecretKey = this.configuration.secret_key;

    // Validate webhook event
    const hash = crypto
      .createHmac("sha512", webhookSecretKey)
      .update(rawData)
      .digest("hex");

    if (hash !== headers["x-paystack-signature"]) {
      return {
        action: PaymentActions.NOT_SUPPORTED,
      };
    }

    // Validate event type
    if (event !== "charge.success") {
      return {
        action: PaymentActions.NOT_SUPPORTED,
      };
    }

    const sessionId = data.metadata?.session_id;

    if (!sessionId) {
      if (this.debug) {
        console.error(
          "PS_P_Debug: No sessionId found in webhook transaction metadata",
        );
      }
      return {
        action: PaymentActions.NOT_SUPPORTED,
      };
    }

    if (this.debug) {
      console.info(
        "PS_P_Debug: Webhook event is valid",
        JSON.stringify({ sessionId, amount: data.amount }, null, 2),
      );
    }

    return {
      action: PaymentActions.AUTHORIZED,
      data: {
        session_id: sessionId,
        amount: data.amount,
      },
    };
  }

  /**
   * Marks payment as captured. Transactions are 'captured' by default in Paystack.
   * So this just returns the payment session data.
   */
  async capturePayment(
    paymentSessionData: CapturePaymentInput,
  ): Promise<CapturePaymentOutput> {
    return paymentSessionData;
  }

  /**
   * Cancel payment for Paystack payment intent.
   * This is not supported by Paystack - transactions are stateless.
   */
  async cancelPayment(
    paymentSessionData: CancelPaymentInput
  ): Promise<CancelPaymentOutput> {
    return {data: {
      ...paymentSessionData
    }};
  }

  /**
   * Delete payment for Paystack payment intent.
   * This is not supported by Paystack - transactions are stateless.
   */
  async deletePayment(
    paymentSessionData: DeletePaymentInput
  ): Promise<DeletePaymentOutput> {
    return paymentSessionData;
  }

  protected buildError(message: string, e: unknown): MedusaError {
    const errorMessage = "Paystack Payment error: " + message;
    let code: string | undefined;
    let detail: string | undefined;

    if (e instanceof Error) {
      code = e.message;
      detail = e.stack;
    } else if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      "detail" in e
    ) {
      code = (e as { code?: string }).code;
      detail = (e as { detail: string }).detail;
    }

    return new MedusaError(
      MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR,
      errorMessage,
      code,
      detail,
    );
  }
}

export default PaystackPaymentProcessor;
