# Simple Architecture Metamodel
## Nodes
The metamodel contains the following node types:
- Stakeholder node: This node is depicted in yellow as user icon and is reserved for any stakeholders or users. A Stakeholder that is an AI Agent (see Kind below) is depicted the same way, with a robot icon in place of the user icon.
- Business node: This node is depicted in yellow and is reserved for any business related elements such as business processes, capabilities etc.
- Application node: This node is depicted in blue and is reserved for any application related elements.
- Infrastructure node: This node is depicted in green and is reserved for any infrastructure related elements.
- Other node: This node is depicted in gray and is reserved for any other elements.

### Node standard metadata
Nodes will contain standard metadata properties:

**All nodes:**
- Description

**Stakeholder nodes:**
- Kind (Options: Human, AI Agent). Stored as `"stakeholderKind"`. A Stakeholder without Kind is Human. A stored value that isn't one of the options is a validation warning (it may have been custom metadata before Kind became standard): it is kept as it is and read as Human.

**Business nodes:**
- Owning team

**Application and Infrastructure nodes:**
- Architecture state (Options: Deprecate, Current, Target)
- Functions (an array of functions offered by the element)
- Owning team
- Supplier HQ Country (ISO 3166-1 alpha-2 code, e.g. NL, US)

**Application nodes:**
- Sourcing (Option: Build, Buy)

Custom metadata is allowed to be added as needed

## Edges
The metamodel contains the following edge types:
- Relation edge: This edge is depicted with a solid-line arrow and is used for any relation between elements, such as integration, hosting or serving a business process. A label or custom metadata can say what kind of relation it is.
- Contains edge: This edge is reserved for an element that contains another element. By default, the target element is depicted nested inside the source element.

Several Relation edges may link the same two elements in the same direction.

### Direction
- Relation edges are one-way by default (an arrow at the target) and can be two-way: depicted with an arrow at both ends. A two-way edge is stored with the standard JGF `"directed": false` on the edge; leaving `directed` out, or `true`, is one-way. On a two-way edge, source and target are only the order of its two ends.
- Contains edges are always one-way: a container contains its element, not the other way round. `"directed": false` on a Contains edge is a validation warning, and the edge is read as one-way.

### Edge standard metadata
**All Edges**
- Architecture state (Options: Deprecate, Current, Target)

**Relation edges**
- Identity (free text): the active identity used for the exchange. Stored as `"identity"`.
- Identity Context (free text): additional context, such as the original user's ID. Stored as `"identityContext"`.
- Source to target data (list of texts): the data that goes from the edge's source to its target. Stored as `"sourceToTargetData"`, a JSON list such as `["Orders", "Customer ids"]`.
- Target to source data (list of texts): the data that goes from the target to the source. Stored as `"targetToSourceData"`, a JSON list.

On a two-way edge, the source is the end stored as `source`. Reversing an edge swaps its two lists along with its ends, so the same data flows between the same two elements. In a label, the two lists are written `{Source to Target Data}` and `{Target to Source Data}`.

Identity, Identity Context, Source to target data and Target to source data are optional and apply to Relation edges only. On a Contains edge, such a key is a validation warning, and the value is kept as it is.

Source to target data and Target to source data each hold zero or more values, in the order they were added; the same value is never there twice, ignoring case, and an empty text is not a value. A single text (as stored before they were lists) is read as a list of that one value. Any other value that isn't a list of texts is a validation warning, and is kept as it is.

Custom metadata is allowed to be added to any edge as needed

## Viewpoints
A viewpoint is a selection of relationship properties: Architecture state, Identity, Identity Context, Data or any custom metadata found on the model's edges.
- Data is one choice for both data lists. An edge shows each list on a line of its own, starting with an arrow pointing the way its data flows on the canvas, the values joined by ", ", leaving out an empty list. On one relationship, the lists are named after its ends ("Order system to Warehouse", "Warehouse to Order system").
- With nothing selected, an edge shows its label, or nothing. An edge never shows its type name.
- With properties selected, an edge that has at least one of them shows their values instead of its label. Any other edge is grayed out.
- Contains edges are never grayed out and keep their label.
- A viewpoint is part of the address, so it can be shared as a link. It changes how edges look, never where elements are.

## Exchange format
This metamodel is always exchanged using the JSON Graph Format (JGF v2, https://jsongraphformat.info/). See `default-metamodel-jgf.json` for the template.

- Nodes are an object keyed by node id. The node type and all properties go in the node's `metadata`.
- The edge type goes in the standard JGF `relation` field (`Relation` or `Contains`).
- The direction goes in the standard JGF `directed` field of the edge: `false` for a two-way Relation edge (see Direction above).
- Older files with `Information flow` or `Integration` still import: both become a Relation. An `Information flow` edge, or an edge with `"informationFlow": true`, that has a label also gets that label as its Source to target data, unless it has Data already; the label stays. `"informationFlow"` itself is no longer stored.
- Older files with Data (`"data"`) still import: Data becomes Source to target data (`"sourceToTargetData"`), unless the edge has it already (then both are kept as they are, with a warning), and every `{Data}` in a label becomes `{Source to Target Data}`.
- Older files with Request Data (`"requestData"`) or Response Data (`"responseData"`) still import: they become Source to target data and Target to source data, each with its value, unless the edge has the new key already (then both are kept as they are, with a warning). Every `{Request Data}` and `{Response Data}` in a label becomes `{Source to Target Data}` and `{Target to Source Data}`.
- Older files with a single text in a data list still import: it becomes a list of that one value, and an empty one is left out.