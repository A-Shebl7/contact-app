/* ==========================================================================
   ContactHub — main.js
   Vanilla JS contact manager: LocalStorage persistence, validation, search,
   favorites / emergency lists, tel: / mailto: actions, SweetAlert2 feedback.
   User-provided text is only ever inserted with textContent / text nodes.
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------------
     Constants & state
     ------------------------------------------------------------------------ */
  var STORAGE_KEY = 'contacts';                       // same key the reference site uses
  var CORRUPT_BACKUP_KEY = 'contacts_corrupt_backup'; // raw copy kept when stored JSON is unreadable
  var AVATAR_SIZE = 256;                              // px, uploaded photos are downscaled to this

  var KNOWN_GROUPS = ['family', 'friends', 'work', 'colleagues', 'business', 'school', 'gym', 'neighbors', 'other'];
  var AVATAR_VARIANTS = 8;
  var HASH_TAG_VARIANTS = 6;

  var state = {
    contacts: [],
    query: '',
    editingId: null,
    avatar: '',
    storageOk: true,
    submitAttempted: false,
    lastFocus: null
  };

  var dom = {};

  /* ------------------------------------------------------------------------
     Small helpers
     ------------------------------------------------------------------------ */

  /** Create an element. Strings in `children` become text nodes (never HTML). */
  function el(tag, props) {
    var node = document.createElement(tag);
    var key;
    if (props) {
      for (key in props) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
        var value = props[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'dataset') Object.keys(value).forEach(function (d) { node.dataset[d] = value[d]; });
        else node.setAttribute(key, value === true ? '' : value);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      node.append(child);
    }
    return node;
  }

  function icon(classes) {
    return el('i', { 'class': classes, 'aria-hidden': 'true' });
  }

  function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'contact_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  function nowIso() { return new Date().toISOString(); }

  function digitsOnly(value) { return String(value || '').replace(/\D/g, ''); }

  function getInitials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    var first = Array.from(parts[0])[0];
    if (parts.length === 1) return first.toUpperCase();
    var last = Array.from(parts[parts.length - 1])[0];
    return (first + last).toUpperCase();
  }

  /** Same colour pick as the reference: name length modulo palette size. */
  function avatarVariant(name) { return String(name || '').length % AVATAR_VARIANTS; }

  /** Group → tag class. Unknown groups get a stable colour from a string hash (as the reference does). */
  function groupTagClass(group) {
    var key = String(group || '').toLowerCase().trim();
    if (KNOWN_GROUPS.indexOf(key) !== -1) return 'tag--' + key;
    var hash = 0;
    for (var i = 0; i < key.length; i++) {
      hash = key.charCodeAt(i) + ((hash << 5) - hash);
    }
    return 'tag--h' + (Math.abs(hash) % HASH_TAG_VARIANTS);
  }

  /** tel: href — keeps a leading "+" and digits only. Empty string when nothing dialable. */
  function telHref(phone) {
    var trimmed = String(phone || '').trim();
    var digits = digitsOnly(trimmed);
    if (!digits) return '';
    return 'tel:' + (trimmed.charAt(0) === '+' ? '+' : '') + digits;
  }

  /** mailto: href — address is percent-encoded but "@" stays readable. */
  function mailHref(email) {
    var trimmed = String(email || '').trim();
    if (!trimmed) return '';
    return 'mailto:' + encodeURIComponent(trimmed).replace(/%40/g, '@');
  }

  function announce(message) {
    if (!dom.liveStatus) return;
    dom.liveStatus.textContent = '';
    window.setTimeout(function () { dom.liveStatus.textContent = message; }, 30);
  }

  /* ------------------------------------------------------------------------
     SweetAlert2 wrappers
     ------------------------------------------------------------------------ */
  function fire(options) {
    if (!window.Swal) {
      // SweetAlert2 did not load (offline / blocked CDN). Never fall back to native dialogs.
      announce([options.title, options.text].filter(Boolean).join('. '));
      return Promise.resolve({ isConfirmed: false, isDismissed: true });
    }
    return window.Swal.fire(options);
  }

  function toast(type, title, text) {
    return fire({ icon: type, title: title, text: text, timer: 1500, showConfirmButton: false });
  }

  function warnNotPersisted() {
    return fire({
      icon: 'warning',
      title: 'Not saved permanently',
      text: 'Your browser could not write to local storage (it may be full or disabled). ' +
            'This change will be lost when you reload the page.'
    });
  }

  function showError(title, text) {
    return fire({ icon: 'error', title: title, text: text });
  }

  /* ------------------------------------------------------------------------
     Storage
     ------------------------------------------------------------------------ */

  function sanitizeContact(raw, usedIds) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var str = function (v) { return typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : ''); };
    var name = str(raw.name).trim();
    if (!name) return null;

    var id = str(raw.id).trim();
    if (!id || usedIds.has(id)) id = generateId();
    usedIds.add(id);

    var createdAt = str(raw.createdAt) || nowIso();
    return {
      id: id,
      name: name,
      phone: str(raw.phone).trim(),
      email: str(raw.email).trim(),
      address: str(raw.address).trim(),
      notes: str(raw.notes).trim(),
      group: str(raw.group).trim(),
      avatar: str(raw.avatar),
      isFavorite: raw.isFavorite === true,
      isEmergency: raw.isEmergency === true,
      createdAt: createdAt,
      updatedAt: str(raw.updatedAt) || createdAt
    };
  }

  function backupCorrupt(raw) {
    try {
      if (localStorage.getItem(CORRUPT_BACKUP_KEY) === null) {
        localStorage.setItem(CORRUPT_BACKUP_KEY, raw);
      }
    } catch (e) { /* storage unavailable – nothing more we can do */ }
  }

  /** Returns { contacts, recovered } and never throws. */
  function loadContacts() {
    var raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      state.storageOk = false;
      return { contacts: [], recovered: false };
    }
    if (raw === null || raw === '') return { contacts: [], recovered: false };

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      backupCorrupt(raw);
      return { contacts: [], recovered: true };
    }
    if (!Array.isArray(parsed)) {
      backupCorrupt(raw);
      return { contacts: [], recovered: true };
    }

    var usedIds = new Set();
    var contacts = [];
    parsed.forEach(function (item) {
      var clean = sanitizeContact(item, usedIds);
      if (clean) contacts.push(clean);
    });
    var droppedSome = contacts.length !== parsed.length;
    if (droppedSome) backupCorrupt(raw);
    return { contacts: contacts, recovered: droppedSome };
  }

  /** Writes the collection. Returns true when persisted. */
  function saveContacts() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.contacts));
      state.storageOk = true;
      return true;
    } catch (e) {
      state.storageOk = false;
      return false;
    }
  }

  /* ------------------------------------------------------------------------
     Data operations
     ------------------------------------------------------------------------ */

  function findContact(id) {
    for (var i = 0; i < state.contacts.length; i++) {
      if (state.contacts[i].id === id) return state.contacts[i];
    }
    return null;
  }

  function addContact(data) {
    var stamp = nowIso();
    var contact = {
      id: generateId(),
      name: data.name,
      phone: data.phone,
      email: data.email,
      address: data.address,
      notes: data.notes,
      group: data.group,
      avatar: data.avatar,
      isFavorite: !!data.isFavorite,
      isEmergency: !!data.isEmergency,
      createdAt: stamp,
      updatedAt: stamp
    };
    state.contacts.push(contact);
    return { contact: contact, saved: saveContacts() };
  }

  function updateContact(id, data) {
    var contact = findContact(id);
    if (!contact) return null;
    // id and createdAt are never touched.
    contact.name = data.name;
    contact.phone = data.phone;
    contact.email = data.email;
    contact.address = data.address;
    contact.notes = data.notes;
    contact.group = data.group;
    contact.avatar = data.avatar;
    contact.isFavorite = !!data.isFavorite;
    contact.isEmergency = !!data.isEmergency;
    contact.updatedAt = nowIso();
    return { contact: contact, saved: saveContacts() };
  }

  function deleteContact(id) {
    var before = state.contacts.length;
    state.contacts = state.contacts.filter(function (c) { return c.id !== id; });
    if (state.contacts.length === before) return null;
    return { saved: saveContacts() };
  }

  function toggleFlag(id, key) {
    var contact = findContact(id);
    if (!contact) return null;
    contact[key] = !contact[key];
    contact.updatedAt = nowIso();
    return { contact: contact, saved: saveContacts() };
  }

  /* ------------------------------------------------------------------------
     Search (name, phone, email) — never mutates stored data
     ------------------------------------------------------------------------ */

  function getFilteredContacts() {
    var query = state.query.trim().toLowerCase();
    if (!query) return state.contacts;

    // Treat the query as a phone number only when it looks like one, so that
    // "ahmed 1" does not match every number containing a 1.
    var phoneLike = /^[\d\s\-().+]+$/.test(query);
    var queryDigits = phoneLike ? digitsOnly(query) : '';
    var digitVariants = [];
    if (queryDigits) {
      digitVariants.push(queryDigits);
      var noLeadingZeros = queryDigits.replace(/^0+/, ''); // 0101… ↔ +20101…
      if (noLeadingZeros && noLeadingZeros !== queryDigits) digitVariants.push(noLeadingZeros);
    }

    return state.contacts.filter(function (c) {
      if (c.name.toLowerCase().indexOf(query) !== -1) return true;
      if (c.email && c.email.toLowerCase().indexOf(query) !== -1) return true;
      if (c.phone.toLowerCase().indexOf(query) !== -1) return true;
      if (digitVariants.length) {
        var phoneDigits = digitsOnly(c.phone);
        return digitVariants.some(function (d) { return phoneDigits.indexOf(d) !== -1; });
      }
      return false;
    });
  }

  /* ------------------------------------------------------------------------
     Validation (shared by add and edit)
     ------------------------------------------------------------------------ */

  var NAME_ALLOWED = /^[\p{L}\p{M}\p{N} .'’\-&]+$/u;
  var EMAIL_FORMAT = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[^\s@.]{2,}$/;

  function validateName(value) {
    if (!value) return 'Please enter a name.';
    var length = Array.from(value).length;
    if (length < 2 || length > 50) return 'Name must be between 2 and 50 characters.';
    if (!NAME_ALLOWED.test(value)) return 'Name can contain letters, numbers, spaces and . \' - & only.';
    var letters = (value.match(/\p{L}/gu) || []).length;
    if (letters < 2) return 'Please enter a meaningful name (at least two letters).';
    return '';
  }

  function validatePhone(value, ignoreId) {
    if (!value) return 'Please enter a phone number.';
    if (!/^\+?[\d\s().\-]+$/.test(value)) {
      return 'Use digits only, with an optional leading + and spaces, dashes or parentheses.';
    }
    var digits = digitsOnly(value);
    if (digits.length < 7 || digits.length > 15) return 'A phone number needs between 7 and 15 digits.';

    var duplicate = state.contacts.find(function (c) {
      return c.id !== ignoreId && digitsOnly(c.phone) === digits;
    });
    if (duplicate) return 'This number already belongs to ' + duplicate.name + '.';
    return '';
  }

  function validateEmail(value) {
    if (!value) return ''; // optional, as in the reference form
    if (value.length > 254 || !EMAIL_FORMAT.test(value)) return 'Please enter a valid email address.';
    return '';
  }

  var FIELD_MAP = {
    name:  { input: 'contactName',  error: 'contactNameError' },
    phone: { input: 'contactPhone', error: 'contactPhoneError' },
    email: { input: 'contactEmail', error: 'contactEmailError' }
  };

  function readForm() {
    return {
      name: dom.name.value.replace(/\s+/g, ' ').trim(),
      phone: dom.phone.value.trim(),
      email: dom.email.value.trim(),
      address: dom.address.value.trim(),
      notes: dom.notes.value.trim(),
      group: dom.group.value,
      isFavorite: dom.favorite.checked,
      isEmergency: dom.emergency.checked,
      avatar: state.avatar
    };
  }

  function runValidator(field, values) {
    if (field === 'name') return validateName(values.name);
    if (field === 'phone') return validatePhone(values.phone, state.editingId);
    return validateEmail(values.email);
  }

  function setFieldError(field, message) {
    var input = dom[field];
    var error = document.getElementById(FIELD_MAP[field].error);
    error.textContent = message;
    input.classList.toggle('is-invalid', !!message);
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function clearErrors() {
    Object.keys(FIELD_MAP).forEach(function (f) { setFieldError(f, ''); });
  }

  /** Validate every field, show messages, return the first invalid field name (or null). */
  function validateAll(values) {
    var firstInvalid = null;
    Object.keys(FIELD_MAP).forEach(function (field) {
      var message = runValidator(field, values);
      setFieldError(field, message);
      if (message && !firstInvalid) firstInvalid = field;
    });
    return firstInvalid;
  }

  /** Live feedback while typing: clears as soon as valid, shows errors for non-empty invalid input. */
  function handleFieldInput(field) {
    var values = readForm();
    var message = runValidator(field, values);
    var rawEmpty = dom[field].value.trim() === '';
    if (rawEmpty && !state.submitAttempted) message = '';
    setFieldError(field, message);
  }

  /* ------------------------------------------------------------------------
     Rendering
     ------------------------------------------------------------------------ */

  function createAvatar(contact, size) {
    var base = 'avatar avatar--' + size;
    var initials = getInitials(contact.name);
    var colorClass = ' avatar--c' + avatarVariant(contact.name);

    if (contact.avatar) {
      var wrapper = el('div', { 'class': base + ' avatar--img' });
      var img = el('img', { src: contact.avatar, alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', function () {
        wrapper.className = base + colorClass;
        wrapper.textContent = initials;
      }, { once: true });
      wrapper.append(img);
      return wrapper;
    }
    return el('div', { 'class': base + colorClass, text: initials });
  }

  function createActionButton(action, contact, cls, iconClasses, title, label, extra) {
    var props = {
      type: 'button',
      'class': 'action-btn ' + cls,
      title: title,
      'aria-label': label,
      dataset: { action: action, id: contact.id }
    };
    if (extra) Object.keys(extra).forEach(function (k) { props[k] = extra[k]; });
    return el('button', props, icon(iconClasses));
  }

  function createContactCard(contact) {
    var avatarWrap = el('div', { 'class': 'contact-card__avatar' }, createAvatar(contact, 'lg'));
    if (contact.isEmergency) {
      avatarWrap.append(el('div', { 'class': 'avatar-badge avatar-badge--emergency' }, icon('fa-solid fa-heart-pulse')));
    }
    if (contact.isFavorite) {
      avatarWrap.append(el('div', { 'class': 'avatar-badge avatar-badge--favorite' }, icon('fa-solid fa-star')));
    }

    var info = el('div', { 'class': 'contact-card__info' },
      el('h3', { 'class': 'contact-card__name truncate', text: contact.name, title: contact.name }),
      el('div', { 'class': 'contact-card__phone' },
        el('span', { 'class': 'mini-icon mini-icon--phone' }, icon('fa-solid fa-phone')),
        el('span', { 'class': 'truncate', text: contact.phone, title: contact.phone })
      )
    );

    var details = el('div', { 'class': 'contact-card__details' });
    if (contact.email) {
      details.append(el('div', { 'class': 'detail-row' },
        el('span', { 'class': 'mini-icon mini-icon--email' }, icon('fa-solid fa-envelope')),
        el('span', { 'class': 'detail-row__text truncate', text: contact.email, title: contact.email })
      ));
    }
    if (contact.address) {
      details.append(el('div', { 'class': 'detail-row' },
        el('span', { 'class': 'mini-icon mini-icon--address' }, icon('fa-solid fa-location-dot')),
        el('span', { 'class': 'detail-row__text truncate', text: contact.address, title: contact.address })
      ));
    }

    var tags = null;
    if (contact.group || contact.isEmergency) {
      tags = el('div', { 'class': 'contact-card__tags' });
      if (contact.group) {
        tags.append(el('span', { 'class': 'tag tag--group ' + groupTagClass(contact.group), text: contact.group }));
      }
      if (contact.isEmergency) {
        tags.append(el('span', { 'class': 'tag tag--emergency' }, icon('fa-solid fa-heart-pulse'), 'Emergency'));
      }
    }

    var body = el('div', { 'class': 'contact-card__body' },
      el('div', { 'class': 'contact-card__top' }, avatarWrap, info),
      details,
      tags
    );

    // Call / Email are real links built from this contact's data.
    var tel = telHref(contact.phone);
    var callControl = tel
      ? el('a', { 'class': 'action-btn action-btn--call', href: tel, title: 'Call', 'aria-label': 'Call ' + contact.name }, icon('fa-solid fa-phone'))
      : el('span', { 'class': 'action-btn action-btn--call is-disabled', 'aria-hidden': 'true' }, icon('fa-solid fa-phone'));

    var mail = mailHref(contact.email);
    var emailControl = mail
      ? el('a', { 'class': 'action-btn action-btn--email', href: mail, title: 'Email', 'aria-label': 'Email ' + contact.name }, icon('fa-solid fa-envelope'))
      : null;

    var favOn = contact.isFavorite;
    var emgOn = contact.isEmergency;
    var footer = el('div', { 'class': 'contact-card__footer' },
      el('div', { 'class': 'action-group' }, callControl, emailControl),
      el('div', { 'class': 'action-group' },
        createActionButton('favorite', contact, 'action-btn--fav' + (favOn ? ' is-on' : ''),
          favOn ? 'fa-solid fa-star' : 'fa-regular fa-star', 'Favorite',
          (favOn ? 'Remove ' : 'Add ') + contact.name + (favOn ? ' from favorites' : ' to favorites'),
          { 'aria-pressed': favOn ? 'true' : 'false' }),
        createActionButton('emergency', contact, 'action-btn--emg' + (emgOn ? ' is-on' : ''),
          emgOn ? 'fa-solid fa-heart-pulse' : 'fa-regular fa-heart', 'Emergency',
          (emgOn ? 'Remove ' : 'Mark ') + contact.name + (emgOn ? ' from emergency contacts' : ' as emergency contact'),
          { 'aria-pressed': emgOn ? 'true' : 'false' }),
        createActionButton('edit', contact, 'action-btn--edit', 'fa-solid fa-pen', 'Edit', 'Edit ' + contact.name),
        createActionButton('delete', contact, 'action-btn--delete', 'fa-solid fa-trash', 'Delete', 'Delete ' + contact.name)
      )
    );

    return el('article', { 'class': 'contact-card' }, body, footer);
  }

  function createEmptyState(searching) {
    return el('div', { 'class': 'empty-state' },
      el('div', { 'class': 'empty-state__icon' }, icon('fa-solid fa-address-book')),
      el('p', { 'class': 'empty-state__title', text: 'No contacts found' }),
      el('p', {
        'class': 'empty-state__hint',
        text: searching ? 'Try a different name, phone number or email' : 'Click "Add Contact" to get started'
      })
    );
  }

  function renderContacts() {
    var list = getFilteredContacts();
    var frag = document.createDocumentFragment();
    if (!list.length) {
      frag.append(createEmptyState(state.query.trim() !== '' && state.contacts.length > 0));
    } else {
      list.forEach(function (c) { frag.append(createContactCard(c)); });
    }
    dom.list.replaceChildren(frag);
  }

  function createQuickItem(contact, kind) {
    return el('div', { 'class': 'quick-item quick-item--' + kind },
      el('div', { 'class': 'quick-item__avatar' }, createAvatar(contact, 'sm')),
      el('div', { 'class': 'quick-item__info' },
        el('h4', { 'class': 'quick-item__name truncate', text: contact.name, title: contact.name }),
        el('p', { 'class': 'quick-item__phone truncate', text: contact.phone })
      ),
      telLink(contact, 'quick-item__call')
    );
  }

  function createQuickTile(contact, kind) {
    var href = telHref(contact.phone);
    var tile = el(href ? 'a' : 'div', {
      'class': 'quick-tile quick-tile--' + kind,
      href: href || null,
      'aria-label': href ? 'Call ' + contact.name : null
    },
      el('div', { 'class': 'quick-tile__avatar' }, createAvatar(contact, 'sm')),
      el('div', { 'class': 'quick-tile__info' },
        el('h4', { 'class': 'quick-tile__name truncate', text: contact.name, title: contact.name }),
        el('p', { 'class': 'quick-tile__phone truncate', text: contact.phone })
      ),
      el('div', { 'class': 'quick-tile__call' }, icon('fa-solid fa-phone'))
    );
    return tile;
  }

  function telLink(contact, cls) {
    var href = telHref(contact.phone);
    if (!href) return el('span', { 'class': cls + ' is-disabled', 'aria-hidden': 'true' }, icon('fa-solid fa-phone'));
    return el('a', { 'class': cls, href: href, title: 'Call', 'aria-label': 'Call ' + contact.name }, icon('fa-solid fa-phone'));
  }

  function fillQuickList(container, contacts, kind, compact) {
    var frag = document.createDocumentFragment();
    if (!contacts.length) {
      frag.append(el('div', {
        'class': 'panel__empty',
        text: kind === 'fav' ? 'No favorites yet' : 'No emergency contacts'
      }));
    } else {
      contacts.forEach(function (c) {
        frag.append(compact ? createQuickTile(c, kind) : createQuickItem(c, kind));
      });
    }
    container.replaceChildren(frag);
  }

  function renderSidebars() {
    var favorites = state.contacts.filter(function (c) { return c.isFavorite; });
    var emergency = state.contacts.filter(function (c) { return c.isEmergency; });
    fillQuickList(dom.favList, favorites, 'fav', false);
    fillQuickList(dom.favListMobile, favorites, 'fav', true);
    fillQuickList(dom.emgList, emergency, 'emg', false);
    fillQuickList(dom.emgListMobile, emergency, 'emg', true);
  }

  function renderStats() {
    var total = state.contacts.length;
    dom.statTotal.textContent = String(total);
    dom.statFavorites.textContent = String(state.contacts.filter(function (c) { return c.isFavorite; }).length);
    dom.statEmergency.textContent = String(state.contacts.filter(function (c) { return c.isEmergency; }).length);
    dom.subtitle.textContent = 'Manage and organize your ' + total + (total === 1 ? ' contact' : ' contacts');
  }

  function renderAll() {
    renderContacts();
    renderSidebars();
    renderStats();
  }

  /* ------------------------------------------------------------------------
     Modal (add / edit)
     ------------------------------------------------------------------------ */

  function renderAvatarPreview() {
    var preview = dom.avatarPreview;
    preview.replaceChildren();
    if (state.avatar) {
      preview.append(el('img', { src: state.avatar, alt: '' }));
    } else if (state.editingId) {
      var contact = findContact(state.editingId);
      preview.textContent = contact ? getInitials(contact.name) : '';
      if (!contact) preview.append(icon('fa-solid fa-user'));
    } else {
      preview.append(icon('fa-solid fa-user'));
    }
  }

  function openModal(contactId) {
    var contact = contactId ? findContact(contactId) : null;
    if (contactId && !contact) return;

    state.lastFocus = document.activeElement;
    state.editingId = contact ? contact.id : null;
    state.submitAttempted = false;

    dom.form.reset();
    clearErrors();
    dom.modalTitle.textContent = contact ? 'Edit Contact' : 'Add New Contact';
    dom.contactId.value = contact ? contact.id : '';
    state.avatar = contact ? contact.avatar : '';

    if (contact) {
      dom.name.value = contact.name;
      dom.phone.value = contact.phone;
      dom.email.value = contact.email;
      dom.address.value = contact.address;
      dom.notes.value = contact.notes;
      dom.group.value = contact.group;
      // A group saved by another version of the app may not exist in the list.
      if (dom.group.value !== contact.group) {
        dom.group.append(el('option', { value: contact.group, text: contact.group }));
        dom.group.value = contact.group;
      }
      dom.favorite.checked = contact.isFavorite;
      dom.emergency.checked = contact.isEmergency;
    }

    renderAvatarPreview();
    dom.modal.hidden = false;
    document.body.classList.add('modal-open');
    dom.modalCard.scrollTop = 0;
    dom.name.focus({ preventScroll: true });
  }

  function closeModal() {
    if (dom.modal.hidden) return;
    dom.modal.hidden = true;
    document.body.classList.remove('modal-open');
    dom.form.reset();
    clearErrors();
    state.editingId = null;
    state.avatar = '';
    state.submitAttempted = false;
    var target = state.lastFocus && document.contains(state.lastFocus) ? state.lastFocus : dom.addBtn;
    if (target && typeof target.focus === 'function') target.focus();
    state.lastFocus = null;
  }

  function trapFocus(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== 'Tab') return;
    var focusables = dom.modalCard.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dom.modalCard)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    state.submitAttempted = true;

    var values = readForm();
    var firstInvalid = validateAll(values);
    if (firstInvalid) {
      dom[firstInvalid].focus();
      announce('The form has errors. Please correct the highlighted fields.');
      return;
    }

    var result;
    var wasEditing = !!state.editingId;
    if (wasEditing) {
      result = updateContact(state.editingId, values);
      if (!result) {
        closeModal();
        renderAll();
        showError('Contact not found', 'This contact no longer exists, so it could not be updated.');
        return;
      }
    } else {
      result = addContact(values);
    }

    closeModal();
    renderAll();

    if (!result.saved) {
      warnNotPersisted();
    } else if (wasEditing) {
      toast('success', 'Updated!', 'Contact has been updated successfully.');
    } else {
      toast('success', 'Added!', 'Contact has been added successfully.');
    }
  }

  /* ------------------------------------------------------------------------
     Avatar upload (downscaled to keep LocalStorage small)
     ------------------------------------------------------------------------ */

  function resizeImage(file, size) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var side = Math.min(img.naturalWidth, img.naturalHeight);
          var sx = (img.naturalWidth - side) / 2;
          var sy = (img.naturalHeight - side) / 2;
          var canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch (e) {
          reject(e);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Unreadable image'));
      };
      img.src = url;
    });
  }

  function handleAvatarChange(event) {
    var input = event.target;
    var file = input.files && input.files[0];
    if (!file) return;
    if (file.type.indexOf('image/') !== 0) {
      input.value = '';
      showError('Unsupported file', 'Please choose an image file.');
      return;
    }
    resizeImage(file, AVATAR_SIZE).then(function (dataUrl) {
      state.avatar = dataUrl;
      renderAvatarPreview();
    }).catch(function () {
      showError('Could not read image', 'Please try a different photo.');
    }).then(function () {
      input.value = '';
    });
  }

  /* ------------------------------------------------------------------------
     Actions from the contact grid
     ------------------------------------------------------------------------ */

  function handleToggle(id, key, labelOn, labelOff) {
    var result = toggleFlag(id, key);
    if (!result) return;
    renderAll();
    announce(result.contact.name + (result.contact[key] ? labelOn : labelOff));
    if (!result.saved) warnNotPersisted();
  }

  function confirmDelete(id) {
    var contact = findContact(id);
    if (!contact) return;
    if (!window.Swal) {
      announce('Deleting needs SweetAlert2 for confirmation, but it did not load. Check your connection and reload.');
      return;
    }
    window.Swal.fire({
      title: 'Delete Contact?',
      text: 'Are you sure you want to delete ' + contact.name + '? This action cannot be undone.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#dc2626',
      cancelButtonColor: '#6b7280',
      confirmButtonText: 'Yes, delete it!',
      cancelButtonText: 'Cancel'
    }).then(function (answer) {
      if (!answer.isConfirmed) return;
      var result = deleteContact(id);
      renderAll();
      if (!result) return;
      if (!result.saved) warnNotPersisted();
      else toast('success', 'Deleted!', 'Contact has been deleted.');
    });
  }

  function handleGridClick(event) {
    var button = event.target.closest('button[data-action]');
    if (!button || !dom.list.contains(button)) return;
    var id = button.dataset.id;
    switch (button.dataset.action) {
      case 'favorite':  handleToggle(id, 'isFavorite', ' added to favorites', ' removed from favorites'); break;
      case 'emergency': handleToggle(id, 'isEmergency', ' marked as emergency contact', ' removed from emergency contacts'); break;
      case 'edit':      openModal(id); break;
      case 'delete':    confirmDelete(id); break;
    }
  }

  /* ------------------------------------------------------------------------
     Init
     ------------------------------------------------------------------------ */

  function cacheDom() {
    var byId = function (id) { return document.getElementById(id); };
    dom.addBtn = byId('addContactBtn');
    dom.modal = byId('contactModal');
    dom.modalCard = byId('modalCard');
    dom.modalWrap = byId('modalWrap');
    dom.modalTitle = byId('modalTitle');
    dom.form = byId('contactForm');
    dom.contactId = byId('contactId');
    dom.name = byId('contactName');
    dom.phone = byId('contactPhone');
    dom.email = byId('contactEmail');
    dom.address = byId('contactAddress');
    dom.group = byId('contactGroup');
    dom.notes = byId('contactNotes');
    dom.favorite = byId('contactFavorite');
    dom.emergency = byId('contactEmergency');
    dom.avatarPreview = byId('avatarPreview');
    dom.avatarInput = byId('avatarInput');
    dom.search = byId('searchInput');
    dom.list = byId('contactsList');
    dom.subtitle = byId('contactsSubtitle');
    dom.statTotal = byId('statTotal');
    dom.statFavorites = byId('statFavorites');
    dom.statEmergency = byId('statEmergency');
    dom.liveStatus = byId('liveStatus');
    dom.favList = document.querySelector('[data-list="favorites"]');
    dom.favListMobile = document.querySelector('[data-list="favorites-mobile"]');
    dom.emgList = document.querySelector('[data-list="emergency"]');
    dom.emgListMobile = document.querySelector('[data-list="emergency-mobile"]');
  }

  function bindEvents() {
    dom.addBtn.addEventListener('click', function () { openModal(null); });
    document.getElementById('closeModalBtn').addEventListener('click', closeModal);
    document.getElementById('cancelModalBtn').addEventListener('click', closeModal);
    dom.form.addEventListener('submit', handleSubmit);
    dom.avatarInput.addEventListener('change', handleAvatarChange);

    // Close on backdrop click (only when the press also started on the backdrop).
    var pressStartedOnBackdrop = false;
    dom.modalWrap.addEventListener('mousedown', function (e) { pressStartedOnBackdrop = e.target === dom.modalWrap; });
    dom.modalWrap.addEventListener('click', function (e) {
      if (e.target === dom.modalWrap && pressStartedOnBackdrop) closeModal();
      pressStartedOnBackdrop = false;
    });
    dom.modal.addEventListener('keydown', trapFocus);

    Object.keys(FIELD_MAP).forEach(function (field) {
      dom[field].addEventListener('input', function () { handleFieldInput(field); });
      dom[field].addEventListener('blur', function () {
        if (dom[field].value.trim() !== '' || state.submitAttempted) handleFieldInput(field);
      });
    });

    dom.search.addEventListener('input', function (e) {
      state.query = e.target.value;
      renderContacts();
    });

    dom.list.addEventListener('click', handleGridClick);


    // Keep several open tabs in sync.
    window.addEventListener('storage', function (e) {
      if (e.key !== STORAGE_KEY && e.key !== null) return;
      state.contacts = loadContacts().contacts;
      renderAll();
    });
  }

  function init() {
    cacheDom();
    var loaded = loadContacts();
    state.contacts = loaded.contacts;
    bindEvents();
    renderAll();

    if (loaded.recovered) {
      fire({
        icon: 'warning',
        title: 'Some saved data could not be read',
        text: 'Unreadable contact data was skipped. A raw backup copy was kept in this browser ' +
              '(key "' + CORRUPT_BACKUP_KEY + '").'
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
