export interface PaymentReceipt {
  chargeId: string;
  amountCents: number;
}

export class PaymentGateway {
  charge(paymentToken: string, amountCents: number): PaymentReceipt {
    if (!paymentToken) throw new Error("A payment token is required");
    return { chargeId: `charge-${amountCents}`, amountCents };
  }
}
