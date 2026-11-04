# Simple Architecture Metamodel
## Nodes
The metamodel contains the following node types:
- Stakeholder node: This node is depicted in yellow as user icon and is reserved for any stakeholders or users.
- Business node: This node is depicted in in yellow and is reserved for any business related elements such as business processess, capabilities etc.
- Application node: This node is depicted in in blue and is reserved for any application related elements.
- Infrastructure node: This node is depicted in in green and is reserved for any infrastructure related elements.
- Other node: This node is depicted in in gray and is reserved for any other elements.

### Node standard metadata
Nodes will contain standard metadata properties:

**All nodes:**
- Description

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
- Information flow (yes or no; default no). It doesn't change how the edge is depicted. This is stored as `"informationFlow": true`.

Custom metadata is allowed to be added to any edge as needed

## Viewpoints
A viewpoint is a selection of relationship properties, for example Information flow: Architecture state, Information flow or any custom metadata found on the model's edges.
- With nothing selected, an edge shows its label, or nothing. An edge never shows its type name.
- With properties selected, an edge that has at least one of them shows their values instead of its label. An edge with Information flow set to yes shows "Information flow"; a no counts as not having it. Any other edge is grayed out.
- Contains edges are never grayed out and keep their label.
- A viewpoint is part of the address, so it can be shared as a link. It changes how edges look, never where elements are.

## Exchange format
This metamodel is always exchanged using the JSON Graph Format (JGF v2, https://jsongraphformat.info/). See `default-metamodel-jgf.json` for the template.

- Nodes are an object keyed by node id. The node type and all properties go in the node's `metadata`.
- The edge type goes in the standard JGF `relation` field (`Relation` or `Contains`).
- The direction goes in the standard JGF `directed` field of the edge: `false` for a two-way Relation edge (see Direction above).
- Older files with `Information flow` or `Integration` still import: `Information flow` becomes a Relation with Information flow set to yes, and `Integration` becomes a Relation.