/**
 * Concept pages for the help panel.
 *
 * Product documentation only — nothing here refers to any particular task. The
 * task statement is delivered by Learn, outside the simulation.
 *
 * Each page has a nav `title`, a page `heading`, a one-line `summary` (the
 * landing page's cards and the page's lead) and an `icon` from ui/Icon.
 */
import { Kbd } from '../ui/primitives.jsx';

export const CONCEPTS = [
  {
    id: 'overview',
    title: 'Start here',
    heading: 'Cosmo Automations',
    icon: 'book',
    summary: 'What this is, the three ideas worth knowing first, and where everything lives.',
    keywords: ['overview', 'start', 'intro', 'cosmo', 'automations'],
    // Rendered by help/Landing.jsx: it links into every other page.
    landing: true,
  },

  {
    id: 'items',
    title: 'Items: how data flows',
    heading: 'Items',
    icon: 'stack',
    summary: 'Everything travels as a list of items, and most nodes run once per item.',
    keywords: ['item', 'items', 'array', 'list', 'data', 'json', 'per item'],
    body: (
      <>
        <p className="body-small">
          Everything that moves between nodes is a <strong>list of items</strong>.
          One item is one record — one order, one customer, one message — and it
          holds a JSON object you reach with <code>$json</code>.
        </p>
        <p className="body-small">
          Even a single result is a list of one. That is why the panels either side
          of a node&apos;s settings are headed with a count: they are showing you
          the list going in and the list coming out.
        </p>

        <h3 className="heading-xsmall">Most nodes run once per item</h3>
        <p className="body-small">
          Give a Filter forty items and it runs forty times, deciding
          independently about each. Give an HTTP Request forty items and it makes
          forty requests. Give Slack forty items and it sends forty messages —
          which is either exactly what you wanted, or a lesson.
        </p>
        <p className="body-small">
          A few nodes are different: they see the <em>whole list at once</em>.
          Aggregate is the main one. Hovering a node in the node panel says which
          mode it uses, and so does the top of its settings.
        </p>

        <p className="ca-help-callout body-xsmall">
          <strong>Why this matters:</strong> &ldquo;how many items are here?&rdquo;
          is the question behind most workflow bugs. One message instead of forty,
          or forty instead of one, is nearly always an item-count problem rather
          than a broken node.
        </p>

        <h3 className="heading-xsmall">Reading the counts</h3>
        <p className="body-small">
          After a run, each connection is labelled with how many items crossed it,
          and the logs list every node&apos;s count as <code>in → out</code>.
          Follow those numbers from the trigger and you can see exactly where a
          workflow stopped doing what you expected.
        </p>
      </>
    ),
  },

  {
    id: 'lists',
    title: 'One item or many',
    heading: 'One item or many',
    icon: 'branch',
    summary: 'Split Out turns one item into many; Aggregate turns many into one.',
    keywords: ['split', 'split out', 'aggregate', 'fan', 'many', 'one', 'group', 'combine'],
    body: (
      <>
        <p className="body-small">
          Two nodes exist purely to change <em>how many items</em> are in flight.
          They do not change how nodes are wired — they change what travels along
          the wire.
        </p>

        <h3 className="heading-xsmall">Split Out: one item → many</h3>
        <p className="body-small">
          An API usually answers a request for a collection with{' '}
          <strong>one</strong> response containing a list inside it. To the
          workflow that is a single item with a list-shaped field, so a Filter
          placed after it runs <em>once</em>, on the wrapper — not once per record.
        </p>
        <p className="body-small">
          Split Out unpacks that list into one item per entry, so every later node
          gets to see the records individually.
        </p>
        <figure className="ca-help-example">
          <figcaption className="body-xxsmall">1 item in — a list inside a wrapper</figcaption>
          <pre className="ca-json body-xxsmall">{`{ "count": 3,
  "orders": [ {"id":"A","total":10},
              {"id":"B","total":20},
              {"id":"C","total":30} ] }`}</pre>
        </figure>
        <figure className="ca-help-example">
          <figcaption className="body-xxsmall">3 items out — after Split Out on <code>orders</code></figcaption>
          <pre className="ca-json body-xxsmall">{`{ "id": "A", "total": 10 }
{ "id": "B", "total": 20 }
{ "id": "C", "total": 30 }`}</pre>
        </figure>

        <h3 className="heading-xsmall">Aggregate: many items → one</h3>
        <p className="body-small">
          Aggregate is the reverse. It waits for the whole list, then emits a
          single item — a count, a total, a combined list. Use it when the outcome
          should be one thing rather than one per record.
        </p>
        <figure className="ca-help-example">
          <figcaption className="body-xxsmall">3 items in → 1 item out</figcaption>
          <pre className="ca-json body-xxsmall">{`// summarize: count → count, sum(total) → total
{ "count": 3, "total": 60 }`}</pre>
        </figure>

        <h3 className="heading-xsmall">
          &ldquo;Why not just connect the nodes directly?&rdquo;
        </h3>
        <p className="body-small">
          This is the right question to ask, and the answer is that a connection
          does not reshape anything. A wire carries the list it is given, exactly
          as it is. It never unpacks a list-shaped field for you, and it never
          collapses many items into one.
        </p>
        <p className="body-small">So, concretely:</p>
        <ul className="body-small">
          <li>
            <strong>Without Split Out</strong>, a node after the fetch receives{' '}
            <em>one</em> item. It runs once. <code>{'{{ $json.total }}'}</code>{' '}
            is <code>[undefined]</code>, because <code>total</code> is a field on
            the entries inside the list, not on the wrapper. A Filter here either
            keeps the whole response or discards the whole response — it cannot
            keep three of the twelve records, because as far as it is concerned
            there is only one thing to judge.
          </li>
          <li>
            <strong>Without Aggregate</strong>, everything downstream stays
            per-item. Twelve items reaching Slack is twelve messages. There is no
            item anywhere holding a total, because no node has looked at more than
            one record at a time.
          </li>
        </ul>
        <p className="ca-help-callout body-xsmall">
          <strong>Rule of thumb:</strong> Split Out when you need to act on each
          record. Aggregate when the result should be one thing. If a node is
          running the wrong number of times, one of these two is missing — or is
          in the wrong place.
        </p>

        <h3 className="heading-xsmall">Order matters</h3>
        <p className="body-small">
          Aggregate summarises whatever reaches it, so put it{' '}
          <em>after</em> the filtering. Aggregate first and you will faithfully
          total the records you meant to exclude.
        </p>
      </>
    ),
  },

  {
    id: 'expressions',
    title: 'Expressions',
    heading: 'Expressions',
    icon: 'fx',
    summary: 'Read live data in any field with {{ }}, and see what it resolves to as you type.',
    keywords: ['expression', 'json', 'node', 'reference', 'undefined', 'template'],
    body: (
      <>
        <p className="body-small">
          A field holding a fixed value is just that value. Start it with{' '}
          <code>=</code> and it becomes an <strong>expression</strong>: anything
          inside <code>{'{{ }}'}</code> is evaluated against the current item, and
          the rest is kept as literal text.
        </p>

        <figure className="ca-help-example">
          <figcaption className="body-xxsmall">Fixed value vs expression</figcaption>
          <pre className="ca-json body-xxsmall">{`EU                          → the text "EU"
={{ $json.region }}         → whatever that field holds
=Order {{ $json.id }} (EU)  → "Order AC-4801 (EU)"`}</pre>
        </figure>

        <h3 className="heading-xsmall">What you can reference</h3>
        <dl className="ca-help-params">
          <div className="ca-help-param">
            <dt className="body-small"><code>{'{{ $json.field }}'}</code></dt>
            <dd className="body-xsmall">A field on the item being processed. Nested paths and array indexes work: <code>{'{{ $json.body.orders[0].id }}'}</code>.</dd>
          </div>
          <div className="ca-help-param">
            <dt className="body-small"><code>{'{{ $node["Name"].json.field }}'}</code></dt>
            <dd className="body-xsmall">A field from another node&apos;s output, by node name. Useful when the data you need was left behind several steps ago.</dd>
          </div>
          <div className="ca-help-param">
            <dt className="body-small"><code>{'{{ $("Name").item.json.field }}'}</code></dt>
            <dd className="body-xsmall">The same idea, different spelling. <code>.first()</code>, <code>.last()</code> and <code>.all()</code> are also available.</dd>
          </div>
          <div className="ca-help-param">
            <dt className="body-small"><code>{'{{ $itemIndex }}'}</code></dt>
            <dd className="body-xsmall">Position of the current item, starting at 0.</dd>
          </div>
          <div className="ca-help-param">
            <dt className="body-small"><code>{'{{ $items().length }}'}</code></dt>
            <dd className="body-xsmall">How many items arrived at this node.</dd>
          </div>
          <div className="ca-help-param">
            <dt className="body-small"><code>{'{{ $now }}'}</code> · <code>{'{{ $today }}'}</code></dt>
            <dd className="body-xsmall">The run timestamp, and just its date. Fixed for the whole run, so two expressions never disagree.</dd>
          </div>
        </dl>
        <p className="body-small">
          Plain JavaScript works on the values you read:{' '}
          <code>{'{{ $json.name.toUpperCase() }}'}</code>,{' '}
          <code>{'{{ $json.total * 1.2 }}'}</code>,{' '}
          <code>{'{{ $json.total > 1000 }}'}</code>.
        </p>

        <h3 className="heading-xsmall">Seeing what it resolves to</h3>
        <p className="body-small">
          Every expression field shows its current result underneath as you type.
          That is the fastest way to work: get the resolved value right, then move
          on.
        </p>
        <p className="body-small">
          <code>[undefined]</code> means the path does not exist on this item. It
          is almost always a spelling mistake or a missing level — a field on the
          entries inside a list rather than on the wrapper. Open the{' '}
          <strong>Input</strong> panel and click a field to insert its correct
          path.
        </p>

        <h3 className="heading-xsmall">Types survive</h3>
        <p className="body-small">
          A field that is <em>only</em> an expression keeps the value&apos;s real
          type — <code>={'{{ $json.total }}'}</code> stays the number{' '}
          <code>1420</code>, so <code>gt</code> compares numerically. Mix an
          expression with surrounding text and the result is text, because that is
          what you asked for.
        </p>
      </>
    ),
  },

  {
    id: 'apis',
    title: 'APIs and credentials',
    heading: 'APIs and credentials',
    icon: 'key',
    summary: 'Real HTTP against sandboxed services, credentials, and how to read a failure.',
    keywords: ['api', 'http', 'credential', 'auth', '401', 'request', 'sandbox'],
    body: (
      <>
        <p className="body-small">
          The services here behave like real ones. Your request has a real method,
          real headers and a real query string; the response has a real status code
          and real JSON. Nothing about the HTTP is pretended.
        </p>
        <p className="body-small">
          What is arranged is the <em>far end</em>: the services are fixtures
          provided by the task, so every run returns the same data. Only the hosts
          a task provides will answer — anything else is refused, and no request
          ever leaves the sandbox.
        </p>

        <h3 className="heading-xsmall">Credentials</h3>
        <p className="body-small">
          Nodes that talk to a service have a <strong>Credential</strong> setting.
          Create one under <strong>Credentials</strong> in the header, pick it in
          the node, and the node authenticates; leave it unset and a protected
          endpoint answers <code>401 Unauthorized</code>, exactly as it would in
          production. Values are held with your workflow and sent to the service —
          never shown in the report.
        </p>

        <h3 className="heading-xsmall">Reading failures</h3>
        <ul className="body-small">
          <li><code>401</code> — missing or wrong credential.</li>
          <li><code>404</code> — the host is right but the path is not.</li>
          <li><code>403</code> — that host is not part of this task.</li>
          <li>
            A <code>4xx</code>/<code>5xx</code> fails the node by default. Turn on
            <strong> Never Error On Failed Status</strong> to receive it as an item
            instead and branch on it.
          </li>
        </ul>
        <p className="body-small">
          When a node fails, everything after it is skipped rather than run on
          missing data — so read the <em>first</em> error in the logs, not the
          last.
        </p>
      </>
    ),
  },

  {
    id: 'canvas',
    title: 'Working on the canvas',
    heading: 'Working on the canvas',
    icon: 'cursor',
    summary: 'Adding and connecting nodes, running them, node settings, and every shortcut.',
    keywords: ['canvas', 'keyboard', 'shortcut', 'undo', 'connect', 'drag', 'delete', 'branch'],
    body: (
      <>
        <p className="body-small">
          Open the node panel with <strong>+ Add node</strong> at the top left of
          the canvas (or press <code>/</code>), then click a node, or drag it onto
          the canvas. Right-clicking the canvas and choosing{' '}
          <strong>Add node…</strong> opens the same panel, and the node you pick
          lands where you clicked.
        </p>
        <p className="body-small">
          The quickest way to build is the <strong>+</strong> at the end of a
          node&apos;s output. Click it to pick the next node, already connected.
          Drag from it to wire that output to another node&apos;s input — or drop
          the wire on empty canvas to pick a new node right there. You can also
          drag from a node&apos;s right-hand dot to another node&apos;s left-hand
          bar. Double-click a node to open its settings; hover it for quick
          actions.
        </p>
        <p className="body-small">
          <strong>Execute Workflow</strong> sits at the bottom of the canvas, and
          the logs bar under it reports how the last run went — open it to see
          every node&apos;s item counts and errors. After a run, each connection
          shows how many items travelled along it.
        </p>

        <h3 className="heading-xsmall">Branching and merging</h3>
        <p className="body-small">
          One output can feed several nodes — every branch receives the same items.
          One input can be fed by several nodes — their items are combined into a
          single list. And a node such as If has two separate outputs; items sent
          to an output with nothing connected are dropped.
        </p>

        <h3 className="heading-xsmall">Shortcuts</h3>
        <dl className="ca-help-shortcuts">
          {[
            ['/', 'Open the node panel and search it'],
            ['Enter', 'Add the only search match, or open the focused node’s settings'],
            ['Double-click', 'Open a node’s settings'],
            ['⌘D / Ctrl+D', 'Duplicate the selection'],
            ['Delete / Backspace', 'Delete the selected nodes or connection'],
            ['⌘Z / Ctrl+Z', 'Undo — redo with ⇧⌘Z'],
            ['⌘↩ / Ctrl+Enter', 'Execute the workflow'],
            ['Escape', 'Close the settings view, or cancel adding a connected node'],
            ['Right-click', 'Actions for a node, a connection, or the canvas'],
          ].map(([keys, what]) => (
            <div className="ca-help-shortcut" key={keys}>
              <dt>
                {keys.split(' / ').map((k, i) => (
                  <span key={k}>
                    {i > 0 ? <span className="ca-help-or body-xxsmall">or</span> : null}
                    <Kbd>{k}</Kbd>
                  </span>
                ))}
              </dt>
              <dd className="body-xsmall">{what}</dd>
            </div>
          ))}
        </dl>

        <h3 className="heading-xsmall">A node&apos;s settings</h3>
        <p className="body-small">
          Three columns: the items arriving on the left, the parameters in the
          middle, the items produced on the right. The input panel is the fastest
          way to discover field names: in <strong>Schema</strong> view, click a
          field to insert its path into the expression you are editing, or drag
          it onto any field. <strong>Table</strong> shows every item side by side.
          The <strong>fx</strong> button on a field switches it between a fixed
          value and an expression.
        </p>
        <p className="body-small">
          Panels are empty until you have run the workflow, because they show real
          data rather than a guess. Run early and run often; a run costs nothing.
        </p>

        <h3 className="heading-xsmall">Your work is saved</h3>
        <p className="body-small">
          The workflow is saved as you edit and survives a page reload. Undo works
          across everything, including <strong>Reset</strong>.
        </p>
      </>
    ),
  },
];
