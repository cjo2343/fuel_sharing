User avatar showing initials from name with auto-assigned brand colour. Deterministic — same name always yields same colour.

```jsx
<Avatar name="Lars Nielsen" size="md" />
<Avatar name="Sara Thomsen" size="lg" online={true} />
<Avatar name="Christian" size="sm" online={false} />
<Avatar name="Mikkel Bro" size="xl" />
<Avatar src="/photo.jpg" name="Pernille" size="md" />
```

**Sizes:** `xs` (24px), `sm` (32px), `md` (40px — default), `lg` (52px), `xl` (64px).
**Colours:** auto-assigned from brand palette based on name hash — Forest, Leaf, Amber, Sage, Deep Forest, Teal.
