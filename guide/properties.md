# Properties defined by an Admin

For Admins, and for Modellers who fill them in: an Admin defines the extra properties that elements and relationships have, on **Admin → Properties**. They show and work like the standard properties (Owning team, Identity and the others), in every model, so everyone uses the same names in the same way.

- **Element properties** apply to every element, of every type.
- **Relation properties** apply to relationships of the type Relation only.

Nothing else can be added: the forms have no **Add field**, and the server refuses a new key on an element or a relationship from anyone.

## Who can do what

- **Admins** add, edit and delete properties on Admin → Properties.
- **Modellers and Admins** fill them in on the forms in Modelling, and Text and Choice element properties in the catalog too.
- **Everyone with a role** sees them in the details panel, and element properties in the catalog. Element properties can also be used in the filters and **Group by**; relation properties in **Show Viewpoints** and in labels.

## Admin → Properties

The page has two lists, **Element properties** and **Relation properties**, each with its own **New** button. Each list shows the properties by name, with each one's key, its kind ("Text", "Choice · 3 options" or "Reference") and how many elements or relationships hold a value, in how many models. Below each list, **Standard properties** lists the ones the metamodel sets: no property in that list can use their names or keys.

**New element property** and **New relation property** ask for:

- **Name:** what people see, such as "Cost centre". At most 60 characters, without `{` or `}`, and not the name of another property in the same list or of a standard one. An element property can't be called Name, Type or Referenced by. An element property and a relation property may have the same name.
- **Key:** what models and JGF files store the values under, such as `costCentre`. It follows the name until you type in it. At most 100 characters.
- **Kind:**
  - **Text:** any text.
  - **Choice:** one of a list of 2 to 50 options you set. Move options up and down to set the order the form lists them in.
  - **Reference** (element properties only): other elements of the same model, picked with `@` on the element's form (see [Modelling](modelling.md#reference-properties)). A Reference isn't offered in the filters or Group by.

No property is ever required.

**Editing** (the pencil): the name, the kind and the options can always change, and values in the models stay exactly as they are. The key can change only while nothing holds a value under it.

- A value that isn't one of the options (an option you removed, or a value from before the property became a choice) shows on the form and the panel as not in the list. Under the options, **In use, not in the list** shows such values with their counts; add one with its **+**, or all with **Add all**.
- Changing an element property to or from **Reference** keeps its values too. Before you save, the dialog says how many values don't fit the new kind. They show as **Not text**, **Not a choice** or **Not a reference** until someone changes them (see [Modelling](modelling.md#values-that-dont-fit)).

**Deleting** (the bin) deletes the property and its values from every element or relationship in every model, at once. The dialog says how many values in how many models go, and **Delete property** works only once you have typed the property's name. Deleting a Reference property removes its references too, so the elements they pointed to no longer list them under **Referenced by**. It can't be undone.

### Properties from models

Some properties come from the models themselves. Those are marked **From models**, and a note above their list asks you to check them: rename "tier" to "Tier", for example, change its kind, or delete it with its values. Saving one removes the mark.

- **Importing a model:** a custom key that isn't a property yet is added to its list, named after its key, with its values kept (see [Import and export](import-and-export.md)). On elements it becomes a Reference property when every value is a Reference, and a Text property otherwise; on relationships it becomes a Text property. An ArchiMate import adds `archimateType` this way.
- **Upgrading to 0.63.0:** before 0.63.0, Modellers added fields of their own to elements. On upgrade, every such key in every model becomes an element property in the same way, with its values kept. A key that held text on some elements and references on others becomes Text, and its references show as Not text: make it a Reference to flag the text values instead.

## On an element

Every element shows every element property, after its type's standard properties and before Functions, in name order. A Text property offers the values it has in the model; a Choice is a list with "Not set" first; a Reference is the `@` field. Leave it empty, or pick Not set, to give an element no value. The details panel shows them the same way, with "Not set" where there is no value. See [Modelling](modelling.md#change-an-element).

## On a relationship

On a Relation's form in Modelling, the relation properties follow the data lists, in name order, always. A text property is a field that offers the values it has in the model; a choice is a list with "Not set" first. Leave a field empty, or pick Not set, to give a relationship no value. The details panel shows them after the standard properties, with "Not set" where there is no value.

**Relation and Contains.** A Contains has no defined properties. Changing a Relation to a Contains keeps their values as custom metadata on it (the form says which), and changing it back to a Relation shows them in their fields again.

## Show Viewpoints, Group by, labels and AI agents

- Every relation property is a choice in **Show Viewpoints** whenever the model has a Relation. See [The canvas](canvas.md#show-viewpoints).
- Text and Choice element properties are offered in **Group by** and the element list's filters once an element has a value for them. See [The canvas](canvas.md#group-by).
- A relationship's label can show a relation property's value with `{Name}`. A label written with the property's key, such as `{tier}`, keeps working after the property is renamed.
- **AI agents** see an element's and a Relation's defined properties by name, under `definedProperties`, in the MCP read tools. See [Connect an AI agent](connect-an-ai-agent.md#what-the-agent-can-ask).
