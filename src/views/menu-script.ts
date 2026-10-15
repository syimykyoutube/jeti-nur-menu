/** Small progressive enhancements. Visible messages come from i18n data attributes. */
export const menuScript = `
const ownerUi=document.querySelector('[data-owner-ui]');
if(ownerUi){
  const labels=ownerUi.dataset;
  document.querySelectorAll('form[data-availability]').forEach(form=>form.addEventListener('submit',async event=>{
    event.preventDefault();
    const button=form.querySelector('button'),state=button.querySelector('[data-toggle-state]');
    const row=form.closest('[data-item-row]'),status=row.querySelector('[data-item-status]');
    button.disabled=true;form.setAttribute('aria-busy','true');status.textContent=labels.saving;
    try{
      const response=await fetch(form.action,{method:'POST',body:new URLSearchParams(new FormData(form)),credentials:'same-origin',redirect:'error',headers:{Accept:'application/json'}});
      const data=await response.json();
      if(!response.ok){status.textContent=response.status===401?labels.sessionExpired:(data.error||labels.requestFailed);return;}
      if(data.is_available!==0&&data.is_available!==1)throw new Error('invalid response');
      const soldOut=data.is_available===0;
      row.classList.toggle('sold-out',soldOut);button.setAttribute('aria-checked',String(soldOut));
      state.textContent=soldOut?labels.soldOut:labels.no;
      row.querySelector('[data-availability-badge]').textContent=soldOut?labels.soldOut:labels.available;
      form.querySelector('[name=is_available]').value=soldOut?'1':'0';status.textContent=labels.availabilitySaved;
    }catch{status.textContent=labels.requestFailed;}
    finally{button.disabled=false;form.removeAttribute('aria-busy');}
  }));
  document.querySelectorAll('[data-item-form]').forEach(form=>{
    const list=form.querySelector('[data-variant-list]'),add=form.querySelector('[data-add-variant]');
    const template=form.querySelector('template[data-variant-template]'),status=form.querySelector('[data-variant-status]');
    const update=()=>{const rows=list.querySelectorAll('[data-variant-row]');rows.forEach(row=>row.querySelector('[data-remove-variant]').disabled=rows.length<=1);add.disabled=rows.length>=Number(form.dataset.maxVariants);};
    add.addEventListener('click',()=>{if(list.querySelectorAll('[data-variant-row]').length>=Number(form.dataset.maxVariants)){status.textContent=labels.tooManyVariants;return;}list.append(template.content.cloneNode(true));update();list.lastElementChild.querySelector('input').focus();});
    list.addEventListener('click',event=>{const button=event.target.closest('[data-remove-variant]');if(!button)return;if(list.querySelectorAll('[data-variant-row]').length<=1)return;button.closest('[data-variant-row]').remove();update();});update();
  });
  document.querySelectorAll('[data-delete-action]').forEach(select=>{
    const destination=select.closest('form').querySelector('[data-destination]');
    const update=()=>{const move=select.value==='move-items';destination.hidden=!move;destination.querySelector('select').disabled=!move;destination.querySelector('select').required=move;};
    select.addEventListener('change',update);update();
  });
}
`;
