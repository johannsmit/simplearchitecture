# Properties defined by an Admin

For Admins, and for Modellers who fill them in: an Admin defines the extra properties that relationships have, on **Admin → Properties**. They show and work like the standard properties (Identity, the data lists and the others), on every Relation in every model, so everyone uses the same names in the same way.

They apply to relationships of the type Relation only. Elements are unchanged: Modellers still add custom metadata to them with **Add field**.

## Who can do what

- **Admins** add, edit and delete properties on Admin → Properties.
- **Modellers and Admins** fill them in on a Relation's form in Modelling.
- **Everyone with a role** sees them in the relationship's details panel, in Show Viewpoints and in labels.

## Admin → Properties

The page lists the properties by name, with each one's key, its kind ("Text", or "Choice · 3 options") and how many relationships hold a value, in how many models. Below them, **Standard properties of a Relation** lists the ones the metamodel sets: no property can use their names or keys.

**+ New property** asks for:

- **Name:** what people see, such as "Cost centre". It is also how a label uses the property: `{Cost centre}`. At most 60 characters, without `{` or `}`, and not the name of another property or a standard one.
- **Key:** what models and JGF files store the values under, such as `costCentre`. It follows the name until you type in it. At most 100 characters.
- **Kind:** **Text**, any text, or **Choice**, one of a list of 2 to 50 options you set. Move options up and down to set the order the form lists them in.

No property is ever required.

**Editing** (the pencil): the name, the kind and the options can always change, and values in the models stay exactly as they are. A value that isn't one of the options (an option you removed, or a value from before the property became a choice) shows on the form and the panel as not in the list. Under the options, **In use, not in the list** shows such values with their counts; add one with its **+**, or all with **Add all**. The key can change only while no relationship holds a value under it.

**Deleting** (the bin) deletes the property and its values from every relationship in every model, at once. The dialog says how many values in how many models go, and **Delete property** works only once you have typed the property's name. It can't be undone.

### Properties from imports

When an Admin imports a model, a custom key on a relationship that isn't a property yet is added to the list as a text property named after its key, and its values are kept (see [Import and export](import-and-export.md)). Those properties are marked **From models**, and a note above the list asks you to check them: rename "tier" to "Tier", for example, make it a choice, or delete it with its values. Saving one removes the mark. An ArchiMate import adds `archimateType` this way.

## On a relationship

On a Relation's form in Modelling, the properties follow the data lists, in name order, always. A text property is a field that offers the values it has in the model; a choice is a list with "Not set" first. Leave a field empty, or pick Not set, to give a relationship no value. The details panel shows them after the standard properties, with "Not set" where there is no value.

The form has no **Add field**: new properties are added by an Admin, and the server refuses a new key on a relationship from anyone.

**Relation and Contains.** A Contains has no defined properties. Changing a Relation to a Contains keeps their values as custom metadata on it (the form says which), and changing it back to a Relation shows them in their fields again.

## Show Viewpoints, labels and AI agents

- Every defined property is a choice in **Show Viewpoints** whenever the model has a Relation. See [The canvas](canvas.md#show-viewpoints).
- A label can show its value with `{Name}`. A label written with the property's key, such as `{tier}`, keeps working after the property is renamed.
- **AI agents** see a Relation's defined properties by name, under `definedProperties`, in the MCP read tools.
