# Integrarea funcțională upstream — 2026-10-16

Stare: integrare funcțională verificată local. Alegerile de mai jos păstrează îmbunătățirile upstream și contractul explicit al gateway-ului logic.

## Alegeri confirmate

- `/advisor configure` păstrează interfața noastră în trei panouri și starea separată Global/Project. Pickerele native, selecția modelului și nivelului de gândire, acțiunile pentru tools și editorul de interval preiau îmbunătățirile upstream. Salvările rămân serializate, fără pierderea modificărilor făcute în timpul unei salvări.
- Composer și Transcript folosesc modelul upstream cu viewport limitat și publicarea explicită a istoricului. Nu se combină cu împrumutarea implicită a rândurilor din vechiul viewport logic.
- Înălțimea cardurilor se recalculează după conținutul curent, conform upstream. Nu se păstrează artificial înălțimea maximă a unui rezultat parțial. Un edit/write care se termină cu un mesaj scurt trebuie să afișeze mesajul și bordurile, fără vechiul spațiu rezervat.
- Colapsarea normală Bash/Eval și expandarea explicită rămân funcționale. Nu se forțează afișarea integrală a output-ului în scrollback.
- Gateway-ul logic păstrează fiecare parte stabilă fie în viewport, fie în istoricul nativ. Codul/comanda Bash/Eval poate fi publicat înainte de terminarea execuției; separatorul de stare și output-ul în curs rămân editabile. Un card finalizat poate fi publicat fără a aștepta umplerea ecranului.
- Ask, jobs și todo sunt interfețe temporare, nu istoric. Înălțimea lor reală intră în bugetul viewport-ului; rândurile stabile deplasate sunt publicate, nu ascunse până la închiderea panoului.
- La închiderea unei interfețe temporare, spațiul ei dispare. Un ecran de 100 de rânduri poate rămâne cu 90 de rânduri ocupate după eliminarea unui panou de 10 rânduri. Nu se adaugă umplutură pentru a fixa editorul jos și nu se readuce istoricul publicat în regiunea editabilă.
- Aceasta este o diferență intenționată față de politica upstream `chromeFloor`/bottom-padding, inclusiv ancorarea obligatorie introdusă în 18.11.1 prin #15499. Se păstrează continuitatea dintre istoric și răspuns, dar nu umplutura de sub card: și contracția unui card activ urmărește înălțimea actuală, fără a menține artificial editorul pe ultimul rând. Testele de bottom-anchor sunt adaptate la accesibilitate, publicare unică și contracție fără replay.
- Ask își calculează dimensiunea din terminalul real, limitează titlul la bugetul disponibil și indică celelalte întrebări ascunse; navigarea și modificarea răspunsurilor rămân disponibile.
- Rapoartele comenzilor folosesc `ReportPanel` exclusiv ca overlay, fără să consume spațiu în conversație; cele lungi păstrează pagina fullscreen cu scroll. Aceasta corectează alegerea inițială greșită de a monta rapoartele scurte deasupra editorului.
- Nu se publică pe GitHub și nu se construiesc manual binarele native. Launcherul rămâne responsabil pentru build la pornire.

## Extensii compatibile păstrate

- Inserarea notificărilor asincrone înaintea regiunii active și finalizarea task-urilor deja publicate se bazează pe starea de commit upstream, nu pe vechiul protocol de rânduri împrumutate.
- Reconstrucția transcriptului trebuie să recunoască prefixul deja publicat, fără duplicarea istoricului. Reconcilierea folosește commit-uri, prefixe semantice și `RowSplit`.
- Metadatele de poziționare pentru panourile laterale și click-uri sunt proiectate în coordonatele viewport-ului limitat.
- Recuperarea răspunsurilor fără output rămâne deținută de mecanismul nostru limitat de retry; nu se adaugă un al doilea retry peste un buget deja epuizat.
- Înfășurarea upstream a liniilor numerotate este păstrată în implementarea comună a celulelor de cod.
- Detaliile individuale ale resetărilor salvate sunt păstrate; creditele consumate sau expirate nu apar ca expirări viitoare.
- O redimensionare reală imediat după ieșirea din bufferul de resize trece prin recuperarea ancorei. Doar notificările cu aceeași geometrie sunt suprimate; altfel, rândurile native readuse fizic pe ecran de terminal ar putea fi suprascrise.

## Scenarii acoperite

- Comenzile de raport deschid overlay-ul și Esc revine la transcript fără pierderi sau duplicate.
- Introducerea și ștergerea `/advisor configure`, inclusiv în timpul activității, nu taie cardurile Bash/Eval și nu suprapune rândul de usage peste corpul lor.
- Un preview edit/write înalt urmat de o eroare scurtă își recalculează dimensiunea; mesajul și bordura finală rămân vizibile.
- Cele trei panouri advisor, izolarea Global/Project, salvările concurente și toate acțiunile pickerelor native funcționează împreună.
- Reconstrucția transcriptului, resize-ul și rezultatele task-urilor asincrone nu republică prefixe deja afișate.
- Eliminarea unui panou temporar de 10 rânduri dintr-un ecran de 100 lasă editorul pe rândul 90, fără pierdere/duplicare de mesaje, fără arhivarea panoului și fără ștergerea scrollback-ului prin `ESC[3J`.
- Bash/Eval publică numai partea stabilă a comenzii în timpul execuției; completarea publică restul cardului, fără a repeta comanda sau a publica borduri provizorii.
- Testele upstream originale sunt verificate separat de testele noastre; paritatea cu rezultatul vechiului `ours` nu este suficientă.

## Verificare inițială a merge-ului, înaintea corecției overlay-urilor

- Suita terminalului și a controllerelor interactive, inclusiv reconstrucția transcriptului, fuzz-ul de resize și intrarea reală a comenzilor: **5.128 teste trecute, 7 omise de condițiile de platformă, 0 eșecuri**.
- Cele **7 teste de rapoarte prin comenzi reale** trec separat: pagini fullscreen cu scroll, rapoarte inline, revenire cu Esc, toate rândurile conversației prezente o singură dată și fără `ESC[3J`.
- **54 teste upstream originale** pentru transcript și welcome/scrollback trec cu numai importurile redirecționate spre implementarea integrată. Așteptările upstream de bottom-anchor din rapoarte/panouri sunt înlocuite explicit de contractul ales, nu raportate drept teste originale nemodificate care trec.
- Pentru `/changelog full`, poziția conversației după închiderea paginii este comparată cu poziția imediat anterioară deschiderii acesteia. Tastarea comenzii poate afișa un rând temporar de completare; dispariția lui nu trebuie confundată cu deplasarea produsă de overlay.
- Verificarea tipurilor trece în toate pachetele; lint-ul și verificarea formatării trec pe cele 38 de fișiere TypeScript modificate, fără avertismente.
- CLI-ul pornit direct din sursă răspunde la `--version`, iar `--smoke-test` se încheie cu `smoke-test: ok`.
- Verificarea vizuală/interactivă folosește terminalul virtual bazat pe nucleul real Kitty. Nu a fost repornit procesul utilizatorului, nu au fost construite manual componentele native și nu a fost executată o publicare sau verificare CI la distanță. Testele Windows și scenariile tmux condiționate de mediu rămân omise, nu declarate verificate.

## Puncte de investigație dacă afișarea se comportă incorect

- Rutarea rapoartelor: `packages/coding-agent/src/modes/controllers/command-controller.ts`.
- Bugetul viewport-ului, chrome și ancorarea: `packages/tui/src/prompt/composer.ts`.
- Publicarea/reconstrucția istoricului: `packages/tui/src/chrome/transcript-container.ts`.
- Proiecția fizică, completările și panourile laterale: `packages/tui/src/tui.ts`.
- Editorul advisor și evenimentele native: `packages/tui/src/overlays/advisor-config.ts`.

Pentru o regresie vizuală se verifică întâi cine deține rândurile afectate și traseul real de input/render. Nu se presupune că o colapsare normală este un defect și nu se modifică afișarea doar pentru a satisface un test al vechiului mecanism.
