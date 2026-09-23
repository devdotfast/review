export interface FulfillmentJob {
  orderId: string;
}

export class FulfillmentQueue {
  private readonly jobs: FulfillmentJob[] = [];

  enqueue(job: FulfillmentJob): void {
    this.jobs.push(job);
  }

  dequeue(): FulfillmentJob | undefined {
    return this.jobs.shift();
  }
}
