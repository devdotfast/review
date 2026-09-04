import type { ReactElement } from "react";

import {
  createReviewDefinitionSession,
  type PeekableAnchorRef,
  type StoreRef,
} from "../../src/authoring";
import type { LiveReviewTutorialProps } from "../../src/live-review-catalog";
import {
  tutorialActorInputs,
  tutorialAuthoringConversation,
  tutorialStoreInputs,
} from "../../tutorial/fixture";
import { ReviewCodePeek } from "./CodePeek";
import { DatabaseLens, DbUseCase, DbWrite } from "./database-lens";
import { SequenceDiagram } from "./diagrams";
import { AnchorLink } from "./review-components";
import { TutorialAuthoringConversation } from "./tutorial-authoring-conversation";
import {
  TutorialFeature,
  TutorialViewButton,
} from "./tutorial-dynamic-content";
import { TutorialKeymapPicker } from "./tutorial-keymap-picker";

const definitions = createReviewDefinitionSession({
  softwareMap: null,
  baseSoftwareMap: null,
});

const actors = definitions.defineActors(tutorialActorInputs);
const stores = definitions.defineStores(tutorialStoreInputs);

export function LiveTutorialDocument({
  anchors,
}: LiveReviewTutorialProps): ReactElement {
  const anchor = (id: string): PeekableAnchorRef => {
    const resolved = anchors[id];
    if (!resolved) throw new Error(`Tutorial anchor is missing: ${id}`);
    return resolved;
  };
  const checkoutSequence = [
    {
      from: actors.checkout,
      to: actors.orderService,
      label: "Place order",
      anchor: anchor("checkout"),
    },
    {
      from: actors.orderService,
      to: actors.repository,
      label: "Save order",
      anchor: anchor("placeOrder"),
    },
    {
      from: actors.repository,
      to: actors.queue,
      label: "Enqueue fulfillment",
      anchor: anchor("insertOrder"),
    },
    {
      from: actors.queue,
      to: actors.worker,
      label: "Deliver job",
      anchor: anchor("dequeue"),
    },
    {
      from: actors.worker,
      to: actors.shipping,
      label: "Create shipment",
      anchor: anchor("ship"),
    },
  ];

  return (
    <>
      <h2>Welcome</h2>
      <p>
        A Review is a guided, interactive explanation of a code change. The
        document keeps the important code, system views, and feedback in one
        place.
      </p>

      <TutorialAuthoringConversation
        conversation={tutorialAuthoringConversation}
      />

      <h3>Your keybindings</h3>
      <p>
        Choose your editor keys. Review highlights the active choice and uses
        its existing extension and reload flow for Vim and Emacs.
      </p>
      <TutorialKeymapPicker />

      <h3>Put the keybindings to work</h3>
      <p>
        The editor below is live. Try hover, <strong>Go to Definition</strong>,
        or <strong>Go to References</strong> with the same commands you use in
        VS Code.
      </p>
      <ReviewCodePeek anchor={anchor("placeOrder")} />
      <p>
        Prose in the review also supports{" "}
        <AnchorLink anchor={anchor("placeOrder")}>links to code</AnchorLink>.
      </p>

      <h2>Commits and diffs</h2>
      <p>
        Review pins an exact base and head before the agent starts writing. Open{" "}
        <strong>Commits</strong> to see the change in author order. Expand the
        sample commit to see its files, then choose <strong>Open diff</strong>
        to inspect only that commit.
      </p>
      <p>
        The <strong>Diff</strong> tab shows the complete change between the
        pinned base and head. Choose <strong>Review</strong> when you are ready
        to return to this tour.
      </p>
      <TutorialViewButton view="commits">
        Explore the sample commits
      </TutorialViewButton>

      <h2>Comments are threads</h2>
      <p>
        You can attach a thread to any part of the canvas. Move the pointer over
        the code below, select the comment control in the left gutter, and write
        a note.
      </p>
      <ReviewCodePeek anchor={anchor("validateInventory")} />
      <p>
        Choose <strong>Ask now</strong>. The app starts an agent turn in a
        read-only checkout and puts its answer in the same thread. You can
        continue the conversation there.
      </p>
      <p>
        The other standard choice, <strong>Add to review</strong>, holds
        feedback for the next authoring round. This tour uses{" "}
        <strong>Ask now</strong> so you can see the agent reply immediately.
      </p>
      <p>
        Every comment is a thread anchored to one part of the Review. Use the
        <strong>+</strong> button in the toolbar to start a thread about the
        whole Review instead.
      </p>

      <h2>Interactive Diagrams</h2>
      <p>
        The sequence diagram connects the checkout request to fulfillment.
        Select any message to open its supporting code.
      </p>
      <SequenceDiagram
        label="Checkout to fulfillment"
        messages={checkoutSequence}
      />
      <p>
        The database view groups writes by use case. Its operations open code
        too.
      </p>
      <DatabaseLens
        title="Order storage"
        stores={stores as unknown as Record<string, StoreRef>}
        height={440}
      >
        <DbUseCase id="create-order" label="Create an order">
          <DbWrite
            from={actors.orderService}
            to={stores.orderDatabase.tables.orders.status}
            label="write pending order"
            anchor={anchor("insertOrder")}
          />
        </DbUseCase>
        <DbUseCase id="fulfill-order" label="Fulfill an order">
          <DbWrite
            from={actors.worker}
            to={stores.orderDatabase.tables.orders.status}
            label="write fulfilled status"
            anchor={anchor("ship")}
          />
        </DbUseCase>
      </DatabaseLens>

      <TutorialFeature feature="softwareMap">
        <p>
          The experimental <strong>Map</strong> moves from the order system to
          its components and code. Select a node to explore the sample service.
        </p>
        <TutorialViewButton view="map">
          Open the software map
        </TutorialViewButton>
      </TutorialFeature>

      <h2>Get help</h2>
      <p>
        To manage the Review skills installed for your agents, open{" "}
        <strong>Preferences → Settings</strong>. To revisit setup or take this
        tour again, open <strong>Preferences → Getting Started</strong>.
      </p>
    </>
  );
}
