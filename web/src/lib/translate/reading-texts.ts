// What a speaker reads aloud to record their own voice, in every language
// the speech service ships: meeting-like, with a question and a livelier
// sentence for intonation, about 15 s at a normal pace, addressing people
// the way that language's translations do. A language added later (an
// operator's LANGUAGES_FILE) gets a prompt to talk freely; the speech
// service transcribes whatever was said.

const READING: Record<string, string> = {
  en: 'Good morning, everyone, and thanks for joining. This week we finally finished the new search feature, and the first results look really promising! What do you think about showing it to our customers next Thursday?',
  sq: 'Mirëmëngjes të gjithëve dhe faleminderit që jeni këtu. Këtë javë më në fund e përfunduam funksionin e ri të kërkimit, dhe rezultatet e para duken vërtet premtuese! Çfarë mendoni, a t\'ua tregojmë klientëve tanë të enjten e ardhshme?',
  be: 'Добрай раніцы ўсім, і дзякуй, што далучыліся. На гэтым тыдні мы нарэшце скончылі новую функцыю пошуку, і першыя вынікі выглядаюць вельмі перспектыўна! Што вы думаеце пра тое, каб паказаць яе нашым кліентам у наступны чацвер?',
  bs: 'Dobro jutro svima i hvala što ste se pridružili. Ove sedmice smo konačno završili novu funkciju pretrage, a prvi rezultati izgledaju zaista obećavajuće! Šta mislite o tome da je pokažemo našim klijentima sljedećeg četvrtka?',
  bg: 'Добро утро на всички и благодаря, че се присъединихте. Тази седмица най-накрая завършихме новата функция за търсене и първите резултати изглеждат наистина обещаващо! Какво ще кажете да я покажем на нашите клиенти следващия четвъртък?',
  ca: 'Bon dia a tothom i gràcies per acompanyar-nos. Aquesta setmana per fi hem acabat la nova funció de cerca, i els primers resultats són realment prometedors! Què els sembla si la mostrem als nostres clients dijous que ve?',
  hr: 'Dobro jutro svima i hvala što ste se pridružili. Ovaj tjedan smo napokon dovršili novu funkciju pretraživanja, a prvi rezultati izgledaju stvarno obećavajuće! Što mislite o tome da je pokažemo našim klijentima idući četvrtak?',
  cs: 'Dobré ráno všem a díky, že jste se připojili. Tento týden jsme konečně dokončili novou funkci vyhledávání a první výsledky vypadají opravdu slibně! Co říkáte na to, že ji příští čtvrtek ukážeme našim zákazníkům?',
  da: 'Godmorgen, og tak fordi du er med. I denne uge blev den nye søgefunktion endelig færdig, og de første resultater ser virkelig lovende ud! Hvad synes du om at vise den til kunderne på torsdag?',
  nl: 'Goedemorgen allemaal, en bedankt dat u erbij bent. Deze week hebben we eindelijk de nieuwe zoekfunctie afgerond, en de eerste resultaten zien er echt veelbelovend uit! Wat vindt u ervan om hem volgende week donderdag aan onze klanten te laten zien?',
  et: 'Tere hommikust kõigile ja aitäh, et liitusite. Sel nädalal saime lõpuks valmis uue otsingufunktsiooni ja esimesed tulemused tunduvad tõesti paljulubavad! Mida Te arvate, kas näitame seda oma klientidele järgmisel neljapäeval?',
  fi: 'Hyvää huomenta, ja kiitos että olet mukana. Tällä viikolla saimme vihdoin uuden hakutoiminnon valmiiksi, ja ensimmäiset tulokset näyttävät todella lupaavilta! Mitä mieltä olet, näytetäänkö se asiakkaillemme ensi torstaina?',
  fr: 'Bonjour à tous, et merci de vous être joints à nous. Cette semaine, nous avons enfin terminé la nouvelle fonction de recherche, et les premiers résultats sont vraiment prometteurs ! Que diriez-vous de la présenter à nos clients jeudi prochain ?',
  de: 'Guten Morgen zusammen, schön, dass Sie dabei sind. Diese Woche haben wir die neue Suchfunktion endlich fertiggestellt, und die ersten Ergebnisse für unsere Kunden sehen wirklich großartig aus! Wollen wir sie nächsten Donnerstag zeigen?',
  el: 'Καλημέρα σε όλους και ευχαριστώ που συνδεθήκατε. Αυτή την εβδομάδα ολοκληρώσαμε επιτέλους τη νέα λειτουργία αναζήτησης, και τα πρώτα αποτελέσματα φαίνονται πραγματικά πολλά υποσχόμενα! Τι λέτε να την παρουσιάσουμε στους πελάτες μας την επόμενη Πέμπτη;',
  hu: 'Jó reggelt mindenkinek, és köszönöm, hogy csatlakoztak. Ezen a héten végre elkészült az új keresőfunkció, és az első eredmények igazán ígéretesek! Mit szólnak hozzá, ha jövő csütörtökön bemutatjuk az ügyfeleinknek?',
  is: 'Góðan daginn öll og takk fyrir að vera með. Í þessari viku kláruðum við loksins nýju leitaraðgerðina, og fyrstu niðurstöðurnar lofa virkilega góðu! Hvað finnst ykkur um að sýna viðskiptavinum okkar hana næsta fimmtudag?',
  it: 'Buongiorno a tutti e grazie per essere qui. Questa settimana abbiamo finalmente completato la nuova funzione di ricerca, e i primi risultati sono davvero promettenti! Che ne pensate di presentarla ai nostri clienti giovedì prossimo?',
  lv: 'Labrīt visiem un paldies, ka pievienojāties. Šonedēļ mēs beidzot pabeidzām jauno meklēšanas funkciju, un pirmie rezultāti izskatās patiešām daudzsološi! Ko Jūs domājat par to, lai nākamajā ceturtdienā to parādītu mūsu klientiem?',
  lt: 'Labas rytas visiems ir ačiū, kad prisijungėte. Šią savaitę pagaliau baigėme naują paieškos funkciją, ir pirmieji rezultatai atrodo tikrai daug žadantys! Ką manote, ar parodykime ją savo klientams kitą ketvirtadienį?',
  lb: 'Gudde Moien alleguer, a merci, datt Dir dobäi sidd. Dës Woch hu mir endlech déi nei Sichfunktioun fäerdeg gemaach, an déi éischt Resultater gesi wierklech villverspriechend aus! Wat haalt Dir dovun, wa mir se nächste Donneschdeg eise Clienten weisen?',
  mk: 'Добро утро на сите и ви благодарам што се приклучивте. Оваа недела конечно ја завршивме новата функција за пребарување, и првите резултати изгледаат навистина ветувачки! Што мислите да ја покажеме на нашите клиенти следниот четврток?',
  mt: 'L-għodwa t-tajba lil kulħadd, u grazzi talli ngħaqadtu magħna. Din il-ġimgħa fl-aħħar lestejna l-funzjoni l-ġdida tat-tfittxija, u l-ewwel riżultati jidhru tassew promettenti! X\'taħsbu dwar li nuruha lill-klijenti tagħna l-Ħamis li ġej?',
  no: 'God morgen, og takk for at du er med. Denne uken ble den nye søkefunksjonen endelig ferdig, og de første resultatene ser virkelig lovende ut! Hva synes du om å vise den til kundene på torsdag?',
  pl: 'Dzień dobry wszystkim i dziękuję, że Państwo dołączyli. W tym tygodniu w końcu skończyliśmy nową funkcję wyszukiwania, a pierwsze wyniki wyglądają naprawdę obiecująco! Co Państwo sądzą o tym, żeby pokazać ją naszym klientom w przyszły czwartek?',
  pt: 'Bom dia a todos e obrigado por estarem aqui. Esta semana finalmente concluímos a nova função de pesquisa, e os primeiros resultados são realmente promissores! O que acham de apresentá-la aos nossos clientes na próxima quinta-feira?',
  ro: 'Bună dimineața tuturor și vă mulțumesc că v-ați alăturat. Săptămâna aceasta am terminat în sfârșit noua funcție de căutare, iar primele rezultate arată cu adevărat promițător! Ce părere aveți dacă o prezentăm clienților noștri joia viitoare?',
  ru: 'Доброе утро всем, и спасибо, что присоединились. На этой неделе мы наконец закончили новую функцию поиска, и первые результаты выглядят очень многообещающе! Что вы думаете о том, чтобы показать её нашим клиентам в следующий четверг?',
  sr: 'Dobro jutro svima i hvala što ste se pridružili. Ove nedelje smo konačno završili novu funkciju pretrage, a prvi rezultati izgledaju zaista obećavajuće! Šta mislite o tome da je pokažemo našim klijentima sledećeg četvrtka?',
  sk: 'Dobré ráno všetkým a ďakujem, že ste sa pripojili. Tento týždeň sme konečne dokončili novú funkciu vyhľadávania a prvé výsledky vyzerajú naozaj sľubne! Čo poviete na to, že ju budúci štvrtok ukážeme našim zákazníkom?',
  sl: 'Dobro jutro vsem in hvala, ker ste se pridružili. Ta teden smo končno dokončali novo funkcijo iskanja in prvi rezultati so res obetavni! Kaj menite, da jo prihodnji četrtek pokažemo našim strankam?',
  es: 'Buenos días a todos y gracias por acompañarnos. Esta semana por fin terminamos la nueva función de búsqueda, ¡y los primeros resultados son realmente prometedores! ¿Qué les parece si se la mostramos a nuestros clientes el próximo jueves?',
  sv: 'God morgon, och tack för att du är med. Den här veckan blev den nya sökfunktionen äntligen klar efter sju veckor, och de första resultaten ser riktigt lovande ut! Vad tycker du om att visa den för kunderna på torsdag den tjugonde?',
  tr: 'Herkese günaydın, katıldığınız için teşekkürler. Bu hafta yeni arama özelliğini nihayet tamamladık ve ilk sonuçlar gerçekten umut verici görünüyor! Önümüzdeki perşembe bunu müşterilerimize göstermeye ne dersiniz?',
  uk: 'Доброго ранку всім, і дякую, що долучилися. Цього тижня ми нарешті завершили нову функцію пошуку, і перші результати виглядають справді багатообіцяюче! Що ви думаєте про те, щоб показати її нашим клієнтам наступного четверга?',
}

export const READING_TIPS = "Read it naturally, as you'd say it in a meeting. A quiet room, a normal distance from the microphone."

/** The text to read, or for other languages a prompt to talk freely; read reports which. */
export function readingText(lang: string): { text: string; read: boolean } {
  const text = READING[lang]
  if (text) return { text, read: true }
  return {
    text: "Tell us, in your own language, what you're working on this week and what comes next, as you would in a meeting.",
    read: false,
  }
}

/** The languages with a text to read. */
export const READING_LANGUAGES = Object.keys(READING)
