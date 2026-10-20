# Bespoke Simulation Template

This document provides precise implementation instructions for creating
embedded applications using the Bespoke Simulation template. Follow these
instructions exactly to ensure consistency across all applications.
NOTE: Never edit this `BESPOKE-TEMPLATE.md` file. Codebase changes should be reflected in the `AGENTS.md` file.

## Required Files Structure

Every application should include these files in the following order:

1. CodeSignal Design System foundations:
   - colors/colors.css
   - spacing/spacing.css
   - typography/typography.css
   - components/button/button.css (used in header)
2. CodeSignal Design System components (optional):
   - components/boxes/boxes.css
   - components/dropdown/dropdown.css
   - components/input/input.css
   - components/tags/tags.css
3. bespoke-template.css (template-specific layout, utilities, temporary
   components)
4. components/modal/modal.css and modal.js (design system; used for help modal)
5. app.js (application logic)
6. server.js (server)

## HTML Template Implementation

1. REPLACE the following placeholders in index.html EXACTLY as specified:

   a) `<!-- APP_TITLE -->`
      Replace with your application's page title
      Example: "Database Designer" or "Task Manager"

   b) `<!-- APP_NAME -->`
      Replace with your application's display name (appears in header)
      Example: "Database Designer" or "Task Manager"

   c) `<!-- APP_SPECIFIC_MAIN_CONTENT -->`
      Add your application's main content area
      Example: `<div id="canvas"></div>` or `<div id="editor"></div>`

   d) `<!-- APP_SPECIFIC_CSS -->`
      Add links to your application-specific CSS files
      Example: `<link rel="stylesheet" href="./my-app.css" />`

   e) `<!-- APP_SPECIFIC_SCRIPTS -->`
      Add links to your application-specific JavaScript files
      Example: `<script src="./my-app-logic.js"></script>`

2. DO NOT modify the core structure (header, script loading order, etc.)

## CSS Implementation

1. ALWAYS use the `.bespoke` class on the body element for scoping
2. USE design system components directly with proper classes:
   - Buttons: `button button-primary`, `button button-secondary`,
     `button button-danger`, `button button-text`
   - Boxes/Cards: `box card` for card containers
   - Inputs: Add `input` class to input elements:
     `<input type="text" class="input" />`
3. USE design system CSS custom properties for styling:
   - Colors: `--Colors-*` (e.g., `--Colors-Primary-Default`,
     `--Colors-Text-Body-Default`)
   - Spacing: `--UI-Spacing-*` (e.g., `--UI-Spacing-spacing-ml`,
     `--UI-Spacing-spacing-xl`)
   - Typography: `--Fonts-*` (e.g., `--Fonts-Body-Default-md`,
     `--Fonts-Headlines-sm`)
   - Borders: `--UI-Radius-*` (e.g., `--UI-Radius-radius-s`,
     `--UI-Radius-radius-m`)
   - Font families: `--body-family`, `--heading-family`
4. FOR custom styling, create app-specific CSS files
5. OVERRIDE design system variables in your app-specific CSS, not in
   bespoke-template.css
6. FOLLOW design system naming conventions for consistency

## JavaScript Implementation

1. HELP MODAL SETUP:
   a) Create help content using help-content-template.html as reference
   b) Use the design system Modal: `Modal.createHelpModal({ title: 'Help', content, triggerSelector: '#btn-help' })`
   c) Include `modal.css` and import `Modal` from `design-system/components/modal/modal.js`

## Error Handling Requirements

1. WRAP all async operations in try-catch blocks
2. PROVIDE meaningful error messages to users
3. LOG errors to console for debugging
4. IMPLEMENT retry logic for network operations
5. HANDLE localStorage quota exceeded errors
6. VALIDATE data before saving operations

## File Naming Conventions

1. CSS files: kebab-case (e.g., my-app.css, task-manager.css)
2. JavaScript files: kebab-case (e.g., my-app.js, task-manager.js)
3. Data files: kebab-case (e.g., solution.json, initial-data.json)
4. Image files: kebab-case (e.g., overview.png, help-icon.svg)

---

# Bespoke Template Design System Guidelines

This section explains how to use the CodeSignal Design System with the
Bespoke template for embedded applications.

## Overview

The Bespoke template uses the CodeSignal Design System for components and
tokens, with template-specific layout and utilities. All styles are scoped
under the `.bespoke` class to prevent interference with parent site styles.
The template uses design system components directly where available, and
provides temporary components (modals, form elements) that will be replaced
when the design system adds them.

## Basic Usage

### 1. Include the CSS

```html
<link rel="stylesheet" href="./bespoke-template.css" />
```

### 2. Wrap Your Application

```html
<div class="bespoke">
  <!-- Your embedded application content goes here -->
</div>
```

### 3. Use the Component Classes

```html
<div class="bespoke">
  <header class="header">
    <h1>My App</h1>
    <button class="button button-text">Help</button>
  </header>

  <main class="main-layout">
    <aside class="sidebar">
      <section class="box card">
        <h2>Settings</h2>
        <form>
          <label>Name
            <input type="text" class="input" placeholder="Enter name" />
          </label>
          <button type="submit" class="button button-primary">Save</button>
        </form>
      </section>
    </aside>

    <div class="content-area">
      <!-- Main content -->
    </div>
  </main>
</div>
```

## Component Reference

### Layout Components

#### Header

```html
<header class="header">
  <h1>App Title</h1>
  <button class="button button-text">Help</button>
</header>
```

#### Main Layout (Sidebar + Content)

```html
<main class="main-layout">
  <aside class="sidebar">
    <!-- Sidebar content -->
  </aside>
  <div class="content-area">
    <!-- Main content area -->
  </div>
</main>
```

#### Cards

```html
<section class="box card">
  <h2>Card Title</h2>
  <h3>Subtitle</h3>
  <p>Card content goes here</p>
</section>
```

### Form Components

#### Labels

```html
<!-- Vertical label -->
<label>Field Name
  <input type="text" class="input" />
</label>
```

#### Input Fields

```html
<!-- Text input -->
<input type="text" class="input" placeholder="Enter text" />

<!-- Select dropdown - native select styling is custom; design system has a Dropdown JS component for richer dropdowns -->
<select class="input">
  <option>Option 1</option>
  <option>Option 2</option>
</select>

<!-- Checkbox (design system component) -->
<label class="input-checkbox">
  <input type="checkbox" />
  <span class="input-checkbox-box"><span class="input-checkbox-checkmark"></span></span>
  <span class="input-checkbox-label">Checkbox Label</span>
</label>

<!-- Radio buttons (design system component) -->
<label class="input-radio">
  <input type="radio" name="option" value="a" />
  <span class="input-radio-circle"><span class="input-radio-dot"></span></span>
  <span class="input-radio-label">Option A</span>
</label>
<label class="input-radio">
  <input type="radio" name="option" value="b" />
  <span class="input-radio-circle"><span class="input-radio-dot"></span></span>
  <span class="input-radio-label">Option B</span>
</label>

<!-- Textarea -->
<textarea class="input" placeholder="Enter your message here..."></textarea>

<!-- Toggle switch - custom component; no design system equivalent yet. Add body-xsmall for typography -->
<label class="row">
  <div class="toggle">
    <input type="checkbox" class="toggle-input" />
    <span class="toggle-slider"></span>
  </div>
  <span class="toggle-label body-xsmall">Enable notifications</span>
</label>
```

#### Buttons

```html
<!-- Text button (default style) -->
<button class="button button-text">Click Me</button>

<!-- Button variants -->
<button class="button button-primary">Primary Action</button>
<button class="button button-danger">Delete</button>
<button class="button button-tertiary">Secondary</button>

<!-- Button as link -->
<a href="#" class="button button-text">Link Button</a>
```

### Modal (Help)

Use the design system Modal component for help/documentation:

```javascript
import Modal from './design-system/components/modal/modal.js';

const helpModal = Modal.createHelpModal({
  title: 'Help',
  content: document.querySelector('#help-content').content.cloneNode(true),
  triggerSelector: '#btn-help'
});
helpModal.open();
```

Include `modal.css` and `modal.js` in your app. See `client/design-system/components/modal/README.md` for full API.

## Customization

Customize via design system CSS variables (`--Colors-*`, `--UI-Spacing-*`, `--Fonts-*`, `--UI-Radius-*`). See design system files for available tokens.

## Theme Support

### Automatic Dark Mode

The framework automatically detects the user's system preference and switches
between light and dark themes. No additional configuration is needed.

## Integration Examples

### Database Designer

```html
<div class="bespoke">
  <header class="header">
    <h1>DB Schema Designer</h1>
    <button id="btn-save" class="button button-primary">Save</button>
    <button class="button button-text">Help</button>
  </header>

  <main class="main-layout">
    <aside class="sidebar">
      <section class="box card">
        <h2>New Table</h2>
        <form>
          <label>Table name
            <input type="text" class="input" placeholder="users" />
          </label>
          <button type="submit" class="button button-primary">Add Table</button>
        </form>
      </section>
    </aside>

    <div class="content-area">
      <!-- Diagram area -->
    </div>
  </main>
</div>
```

## Best Practices

1. **Always wrap in `.bespoke`**: This prevents style conflicts with the parent
   site
2. **Use design system components directly**: Use proper class combinations like
   `button button-primary`
3. **Use semantic HTML**: Combine with proper HTML elements for accessibility
4. **Customize via design system CSS variables**: Override design system
   variables in your app-specific CSS
5. **Test in both themes**: Ensure your app works in light and dark modes
6. **Note on temporary components**: Modal and form components in
   `bespoke-template.css` are temporary and will be replaced when the design
   system adds them

