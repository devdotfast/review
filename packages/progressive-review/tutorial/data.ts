import {
  defineActors,
  defineAnchors,
  defineStores,
} from "virtual:progressive-review-authoring";

import {
  tutorialActorInputs,
  tutorialAnchorInputs,
  tutorialAuthoringConversation,
  tutorialStoreInputs,
} from "./fixture.ts";

export const authoringConversation = tutorialAuthoringConversation;
export const anchors = defineAnchors(tutorialAnchorInputs);
export const actors = defineActors(tutorialActorInputs);

export const checkoutSequence = [
  {
    from: actors.checkout,
    to: actors.orderService,
    label: "Place order",
    anchor: anchors.checkout,
  },
  {
    from: actors.orderService,
    to: actors.repository,
    label: "Save order",
    anchor: anchors.placeOrder,
  },
  {
    from: actors.repository,
    to: actors.queue,
    label: "Enqueue fulfillment",
    anchor: anchors.insertOrder,
  },
  {
    from: actors.queue,
    to: actors.worker,
    label: "Deliver job",
    anchor: anchors.dequeue,
  },
  {
    from: actors.worker,
    to: actors.shipping,
    label: "Create shipment",
    anchor: anchors.ship,
  },
];

export const stores = defineStores(tutorialStoreInputs);
