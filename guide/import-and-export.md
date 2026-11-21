# Import and export

For Admins: how to bring models into SimpleArchitecture and take them out. Both are on **Admin → Models**.

Models are exchanged as [JSON Graph Format](https://jsongraphformat.info/) (JGF) files, following the [default metamodel](../metamodel/default-metamodel.md). SimpleArchitecture can also import ArchiMate exchange files (OEF).

## Export a model

Choose **Export** on the model's row. The browser downloads the model as a JGF file, with every element and relationship and their properties. References are written as stored, as lists of element ids (see the [default metamodel](../metamodel/default-metamodel.md)).

Views aren't part of the export. Treat an exported file as confidential: it holds your organisation's architecture.

## Import a JGF file

Choose **Import file** and pick a `.json` file of at most 5 MB.

- The file becomes a **new model**. A file saved by Export comes back with the same elements and relationships, under a new id.
- The file is checked in full first. If it has errors, nothing is saved and the result lists them. Warnings don't stop an import; the result lists them too.
- Every relationship without an id gets one, so it can be put in a view.
- An element's References keep the other elements of the same file they point to, each once, at most 200. Anything else is left out: an id that isn't an element in the file, the element's own id, an element named twice, and any past the first 200. A Reference left with no element is removed.
- Files written for older versions of the format are converted as they are imported, with a note in the result.

## Import an ArchiMate file

Choose **Import file** and pick an ArchiMate exchange file (OEF, `.xml`) of at most 10 MB. ArchiMate's element and relationship types become the metamodel's:

- The mapping is in `config/oef-mapping.json`. It maps ArchiMate's relationship types to Relation or Contains, and a rule can reverse a relationship's direction (its two data lists swap with it).
- A Flow becomes a Relation, with its name as the data that goes from its source to its target.
- An Association that isn't marked as directed becomes a two-way Relation. Every other relationship runs one way.
- Each element's and relationship's original ArchiMate type is kept, as `archimateType`.

## The import result

After an import, the result shows what was brought in and anything to check:

- **New properties:** a custom key that isn't a property yet is added on **Admin → Properties**, marked From models, with its values kept. The result lists the keys added to Element properties and to Relation properties, each with how many values it holds. A key on elements becomes a Reference property when every value is a Reference, and a Text property otherwise; a key on relationships becomes a Text property. Check these after the import: see [Properties](properties.md#properties-from-models).
- **Property keys changed:** a property name can't be blank or longer than 100 characters, so the import changes such keys instead of failing. A blank key is left out, with its values; a longer one is shortened. The result lists each key, what happened to it, and how many elements or relationships held it.
- **References left out:** for each Reference, what was left out of it and from how many elements.
- **Warnings:** things that don't stop the import but are worth a look.

## Try it with the sample model

The repository's `samples/` folder holds a made-up model, an invented insurer, as `sample-insurance.jgf.json` and as `sample-insurance.oef.xml`. Import either one to try the app without your own data.
