'use strict';
/* The character packs from packs/index.json (made by website/scripts/build.mjs). The home
   page's live demo and the gallery's live preview show their characters as chips. Names and
   descriptions are always set as text, never as markup. */

window.AgentBuddyPacks = (() => {
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // "Biscuit, the puppy" when the pack names the kind of character.
  const fullName = (character) => (character.kind ? `${character.name}, the ${character.kind}` : character.name);

  // Resolves with the packs that have characters. Without the list, it resolves with none.
  const loaded = fetch('packs/index.json')
    .then((response) => (response.ok ? response.json() : { packs: [] }))
    .then(({ packs }) => (Array.isArray(packs) ? packs.filter((pack) => pack?.characters?.length) : []))
    .catch(() => []);

  // The pack's name, then a chip for each character. With `few`, only the first characters
  // show, and a link goes to the pack in the gallery.
  function chips(pack, few) {
    const label = element('p', 'pack-name', pack.name);
    label.id = `chips-${pack.id}`;
    const row = element('div', 'chips');
    for (const character of few ? pack.characters.slice(0, few) : pack.characters) {
      const chip = element('button', 'chip', character.name);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', 'false');
      chip.dataset.char = character.id;
      chip.title = fullName(character);
      if (character.kind) chip.setAttribute('aria-label', fullName(character));
      row.append(chip);
    }
    const group = element('div', 'pack-chips');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-labelledby', label.id);
    group.append(label, row);
    if (few) {
      const count = pack.characters.length;
      const more = element('a', 'pack-more', count > few ? `See all ${count} characters in the gallery ` : 'See them in the gallery ');
      more.href = `gallery.html#pack-${pack.id}`;
      const arrow = element('span', '', '›');
      arrow.setAttribute('aria-hidden', 'true');
      more.append(arrow);
      group.append(more);
    }
    return group;
  }

  // Adds the packs to the panel's "Character packs" (#live-packs) and resolves with them.
  const showChips = (few) => loaded.then((packs) => {
    if (packs.length) {
      document.querySelector('#live-pack-groups').append(...packs.map((pack) => chips(pack, few)));
      document.querySelector('#live-packs').hidden = false;
    }
    return packs;
  });

  // Hides the chip of each character that the engine can't load, then each pack without chips.
  function hideMissing(available) {
    const groups = [...document.querySelectorAll('#live-pack-groups .pack-chips')];
    for (const group of groups) {
      const characters = [...group.querySelectorAll('[data-char]')];
      for (const chip of characters) if (!available.includes(chip.dataset.char)) chip.hidden = true;
      group.hidden = characters.every((chip) => chip.hidden);
    }
    document.querySelector('#live-packs').hidden = groups.every((group) => group.hidden);
  }

  return { element, fullName, showChips, hideMissing };
})();
