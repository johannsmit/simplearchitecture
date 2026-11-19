# Properties defined by an Admin

An Admin defines the extra properties that relationships have, on **Admin → Properties**. They show and work like the standard properties (Identity, Source to target data and the others), on every Relation in every model, so everyone uses the same names in the same way. They apply to relationships of the type Relation only; elements are unchanged and still take custom metadata.

## Who can do what

- **Admins** add, edit and delete properties on Admin → Properties.
- **Modellers and Admins** fill them in on a Relation's form in Modelling.
- **Everyone with a role** sees them in the relationship's details panel, in Show Viewpoints and in labels.
- The server checks the role on every request, whatever the screen shows. Definitions are stored in the database, so they need PostgreSQL, as editing does.

## Admin → Properties

The page lists the properties by name, with each one's key, its kind ("Text", or "Choice · 3 options") and how many relationships hold a value in how many models. Below them, **Standard properties of a Relation** lists the ones the metamodel sets: no property can use their names or keys.

**+ New property** asks for:

- **Name**: what people see, such as "Cost centre". It is also how a label uses the property: `{Cost centre}`. At most 60 characters, without `{` or `}`, and not the name of another property or a standard one.
- **Key**: what models and JGF files store the values under, such as `costCentre`. It follows the name until you type in it. At most 100 characters; `__proto__` can't be used, as on any custom metadata (see the README).
- **Kind**: **Text**, any text, or **Choice**, one of a list of 2 to 50 options you set. Move options up and down to set the order the form lists them in; `Enter` in an option adds another after it.

No property is ever required.

**Editing** (the pencil): the name, the kind and the options can always change, and values in the models stay exactly as they are. A value that isn't one of the options (an option you removed, or a value from before the property became a choice) shows on the form and the panel as not in the list. Under the options, **In use, not in the list** shows such values with their counts; add one with its +, or all with **Add all**. The key can change only while no relationship holds a value under it: once one does, it is locked.

**Deleting** (the bin) deletes the property and its values from every relationship in every model, at once. The dialog says how many values in how many models go, and **Delete property** works only once you have typed the property's name. It can't be undone. Each model changed gets a new version, so someone with one of those relationships open is told it changed when they save.

### Properties from models

Before this version, Modellers could add any custom metadata to a relationship. When this version first starts, every custom key found on relationships in the stored models becomes a text property named after its key, `archimateType` from an ArchiMate import included. Those properties are marked **From models**, and a note above the list asks you to check them: rename "tier" to "Tier", for example, make it a choice, or delete it with its values. Saving one removes the mark. Nothing in the models changes.

## On a relationship

On a Relation's form in Modelling, the properties follow the data lists, in name order, always: a text property is a field that offers the values it has in the model, a choice a list with "Not set" first. Leave a field empty, or pick Not set, to give a relationship no value. The details panel shows them after the standard properties, with "Not set" where there is no value.

The form has no **Add field**: new properties are added by an Admin. A value kept on a Contains (see below) can be changed or removed, but no new key can be added to any relationship, by anyone; the server refuses it too.

**Relation and Contains.** A Contains has no defined properties. Changing a Relation to a Contains keeps their values as custom metadata on it (the form says which), and changing it back to a Relation shows them in their fields again.

**Show Viewpoints and labels.** Every defined property is a choice in Show Viewpoints whenever the model has a Relation, and a label can show its value with `{Name}`. A label written with the property's key, such as `{tier}`, keeps working after the property is renamed.

**AI agents** see a Relation's defined properties by name, under `definedProperties`, in the MCP read tools.

## Import

When an Admin imports a model (JGF or ArchiMate), a custom key on a relationship that isn't a property yet is added to the list as a text property, marked From models, and its values are kept. The import result lists them under **New properties**, with a link to Admin → Properties. A key that is a property already shows as that property. Custom keys on elements stay custom metadata, as before.

A property's key can't be blank or longer than 100 characters, so an import changes such keys on relationships, and never fails over one:

- A key over 100 characters is **shortened** to its first 100 (spaces at either end left out). If that is a key the model's relationships use already, or a standard one, it gets " (2)", " (3)" … and stays within 100 characters. The values are kept under the shortened key, which becomes a property like any other. Importing the same file again uses the same shortened keys.
- A **blank** key (empty, or only spaces) is **left out**, with its values.

Custom metadata names on elements follow the same rules: a name over 100 characters is shortened (with " (2)", " (3)" … when another element's name, a standard property or a reserved name such as `type` has it), and a blank one is left out with its value. They stay custom metadata: no property is added for them.

The import result lists them under **Property keys changed**, in a table for elements and one for relationships: each key as the file has it (cut short when long), what happened to it, and how many elements or relationships held a value under it.

A blank or long key that an earlier version added as a property (when it first started, or on an import) keeps working: its values can be changed and removed on the relationship form and through the API, and an Admin can rename the property or delete it with its values. A blank key an earlier import left on a relationship shows as **Blank** under its custom metadata, and can be removed there. On an element, a blank or long name an earlier import left can have its value changed, be removed, or be renamed by typing a new name over it, on the element form and through the API.
