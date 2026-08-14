/* =====================================================================
 * SYNDICATE — RSS headlines → where to post
 * ---------------------------------------------------------------------
 * Feedly (and every other reader) answers "what is new". This view
 * answers the next question: given a headline and whatever body the
 * feed carried, which Reddit communities take that kind of article.
 *
 * The default catalog is Politics and News folders from an OPML export.
 * Sports, podcasts and pop/entertainment folders are left out on purpose
 * — discovery is civic, and matching sports recaps into progressive
 * spheres would only invent confidence. Tech is optional (off by default).
 *
 * Feeds do not send CORS headers, so a browser cannot read them
 * directly. Fetch goes through a short chain of public readers
 * (rss2json, then a CORS proxy + local XML parse). Importing an OPML
 * or pasting feed XML still works when the network path fails.
 * ===================================================================== */
(function () {
  "use strict";

  const Syndicate = {};
  const STORAGE_KEY = "rj.syndicate";
  const PER_FEED = 8;
  const FEED_CONCURRENCY = 3;
  /* Headlines survive page refresh in localStorage this long, then drop. */
  const ARTICLE_TTL_MS = 24 * 60 * 60 * 1000;
  /* Bump when match-cache shape or suggest semantics change so stale
   * destination tips from an older build are discarded (articles stay). */
  const MATCH_CACHE_REV = 4;

  /* Curated from data/subscriptions.opml. Politics + News on by
   * default; Tech available; sports / podcasts / pop folders skipped. */
  const CATALOG = [
    {"title":"TechCrunch","xmlUrl":"http://feeds.feedburner.com/Techcrunch","htmlUrl":"https://techcrunch.com/","category":"Tech","defaultOn":false,"altUrl":"https://feeds.feedburner.com/Techcrunch","id":"2bce280c81"},
    {"title":"TheAppleBlog — Apple and iOS News, Tips and Reviews","xmlUrl":"http://theappleblog.com/feed/","htmlUrl":"https://gigaom.com/","category":"Tech","defaultOn":false,"altUrl":"https://theappleblog.com/feed/","id":"f6c179c799"},
    {"title":"Macworld","xmlUrl":"http://www.macworld.com/rss.xml","htmlUrl":"https://www.macworld.com","category":"Tech","defaultOn":false,"altUrl":"https://www.macworld.com/rss.xml","id":"a1c8e0f4b2"},
    {"title":"Apple Hot News","xmlUrl":"http://www.apple.com/main/rss/hotnews/hotnews.rss","htmlUrl":"http://www.apple.com/hotnews/","category":"Tech","defaultOn":false,"altUrl":"https://www.apple.com/main/rss/hotnews/hotnews.rss","id":"7d3a91bc40"},
    {"title":"The Hacker News","xmlUrl":"http://thehackernews.com/feeds/posts/default","htmlUrl":"https://thehackernews.com","category":"Tech","defaultOn":false,"altUrl":"https://thehackernews.com/feeds/posts/default","id":"c4e8f2a901"},
    {"title":"Engadget","xmlUrl":"http://www.engadget.com/rss.xml","htmlUrl":"http://www.engadget.com","category":"Tech","defaultOn":false,"altUrl":"https://www.engadget.com/rss.xml","id":"b9d0c3e712"},
    {"title":"Lifehacker","xmlUrl":"http://lifehacker.com/index.xml","htmlUrl":"https://lifehacker.com/feed/rss","category":"Tech","defaultOn":false,"altUrl":"https://lifehacker.com/index.xml","id":"e2f1a8d563"},
    {"title":"MacOSXHints.com","xmlUrl":"http://www.macosxhints.com/backend/geeklog.rdf","htmlUrl":"http://hints.macworld.com","category":"Tech","defaultOn":false,"altUrl":"https://www.macosxhints.com/backend/geeklog.rdf","id":"11a0b7c829"},
    {"title":"Android Developers Blog","xmlUrl":"http://feeds.feedburner.com/blogspot/hsDu","htmlUrl":"http://android-developers.googleblog.com/","category":"Tech","defaultOn":false,"altUrl":"https://feeds.feedburner.com/blogspot/hsDu","id":"88c3d5e1a0"},
    {"title":"Android Phone Fans","xmlUrl":"http://phandroid.com/feed/","htmlUrl":"https://phandroid.com/","category":"Tech","defaultOn":false,"altUrl":"https://phandroid.com/feed/","id":"55b2e9f0c7"},
    {"title":"The Official Google Blog","xmlUrl":"http://googleblog.blogspot.com/atom.xml","htmlUrl":"https://blog.google/","category":"Tech","defaultOn":false,"altUrl":"https://blog.google/atom.xml","id":"d0a4f6b318"},
    {"title":"CISA Cybersecurity Advisories","xmlUrl":"http://www.us-cert.gov/channels/techalerts.rdf","htmlUrl":"https://www.cisa.gov/","category":"Tech","defaultOn":false,"altUrl":"https://www.cisa.gov/cybersecurity-advisories/all.xml","id":"9f7e2c1b64"},
    {"title":"Hello Android","xmlUrl":"http://www.helloandroid.com/rss.xml","htmlUrl":"http://www.helloandroid.com","category":"Tech","defaultOn":false,"altUrl":"https://www.helloandroid.com/rss.xml","id":"3c8a1d5e90"},
    {"title":"Google Mac Blog","xmlUrl":"http://googlemac.blogspot.com/atom.xml","htmlUrl":"http://googlemac.blogspot.com/","category":"Tech","defaultOn":false,"altUrl":"https://googlemac.blogspot.com/atom.xml","id":"6b5d9a2e13"},
    {"title":"Krebs on Security","xmlUrl":"http://krebsonsecurity.com/feed/","htmlUrl":"https://krebsonsecurity.com","category":"Tech","defaultOn":false,"altUrl":"https://krebsonsecurity.com/feed/","id":"f1c3a7e258"},
    {"title":"MacRumors: Mac News and Rumors - Front Page","xmlUrl":"http://www.macrumors.com/macrumors.xml","htmlUrl":"https://www.macrumors.com","category":"Tech","defaultOn":false,"altUrl":"https://feeds.macrumors.com/MacRumors-All","id":"a8e2d4c169"},
    {"title":"BleepingComputer","xmlUrl":"http://www.bleepingcomputer.com/feed/","htmlUrl":"https://www.bleepingcomputer.com/","category":"Tech","defaultOn":false,"altUrl":"https://www.bleepingcomputer.com/feed/","id":"27d9b0f4a5"},
    {"title":"Microsoft Security Blog","xmlUrl":"http://blogs.technet.com/mmpc/rss.xml","htmlUrl":"https://www.microsoft.com/en-us/security/blog/","category":"Tech","defaultOn":false,"altUrl":"https://www.microsoft.com/en-us/security/blog/feed/","id":"c5e1a3f870"},
    {"title":"Washington Post: Breaking News, World, US, DC News & Analysis","xmlUrl":"http://www.washingtonpost.com/rss/homepage","htmlUrl":"http://www.washingtonpost.com/pb/homepage/","category":"News","defaultOn":true,"altUrl":"https://feeds.washingtonpost.com/rss/national","id":"wapo-home01"},
    {"title":"Reuters: Top News","xmlUrl":"http://feeds.reuters.com/reuters/topNews?irpc=69","htmlUrl":"https://www.reuters.com","category":"News","defaultOn":true,"altUrl":"https://www.reutersagency.com/feed/?best-topics=political-general&post_type=best","id":"reuters-top"},
    {"title":"New York Magazine","xmlUrl":"http://feeds.feedburner.com/nymag/intelligencer","htmlUrl":"https://nymag.com/intelligencer","category":"News","defaultOn":true,"altUrl":"https://nymag.com/intelligencer/rss.xml","id":"nymag-intel"},
    {"title":"New York Post","xmlUrl":"http://www.nypost.com/rss/news.xml","htmlUrl":"https://nypost.com","category":"News","defaultOn":true,"altUrl":"https://nypost.com/feed/","id":"nypost-news"},
    {"title":"BBC News","xmlUrl":"http://newsrss.bbc.co.uk/rss/newsonline_world_edition/front_page/rss.xml","htmlUrl":"https://www.bbc.co.uk/news","category":"News","defaultOn":true,"altUrl":"https://feeds.bbci.co.uk/news/world/rss.xml","id":"bbc-world"},
    {"title":"FOX News","xmlUrl":"http://feeds.foxnews.com/foxnews/latest","htmlUrl":"https://www.foxnews.com/","category":"News","defaultOn":true,"altUrl":"https://moxie.foxnews.com/google-publisher/latest.xml","id":"fox-latest"},
    {"title":"Denver Business News - Local Denver News | Denver Business Journal","xmlUrl":"http://www.bizjournals.com/rss/feed/daily/denver","htmlUrl":"https://www.bizjournals.com","category":"News","defaultOn":true,"altUrl":"https://www.bizjournals.com/rss/feed/daily/denver","id":"denver-biz"},
    {"title":"Google News","xmlUrl":"http://news.google.com/news?pz=1&cf=all&ned=us&hl=en&topic=h&num=3&output=rss","htmlUrl":"https://news.google.com/?hl=en-US&gl=US&ceid=US:en","category":"News","defaultOn":true,"altUrl":"https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en","id":"google-news"},
    {"title":"Chicago Breaking News","xmlUrl":"http://feeds.feedburner.com/ChicagoBreakingNews/","htmlUrl":"http://www.chicagotribune.com/news/local/breaking/rss2.0.xml","category":"News","defaultOn":true,"altUrl":"https://www.chicagotribune.com/arcio/rss/category/news/?outputType=xml","id":"chi-break"},
    {"title":"Chicago Sun-Times - News","xmlUrl":"http://www.suntimes.com/rss/news/index.xml","htmlUrl":"https://chicago.suntimes.com/news","category":"News","defaultOn":true,"altUrl":"https://chicago.suntimes.com/rss/news/index.xml","id":"chi-sun"},
    {"title":"The Colorado Sun","xmlUrl":"https://coloradosun.com/feed/","htmlUrl":"https://coloradosun.com/","category":"News","defaultOn":true,"altUrl":"https://coloradosun.com/feed/","id":"colo-sun"},
    {"title":"Vox","xmlUrl":"http://www.vox.com/rss/index.xml","htmlUrl":"https://www.vox.com","category":"News","defaultOn":true,"altUrl":"https://www.vox.com/rss/index.xml","id":"vox-rss"},
    {"title":"CNN","xmlUrl":"http://rss.cnn.com/rss/cnn_topstories.rss","htmlUrl":"https://www.cnn.com/index.html","category":"News","defaultOn":true,"altUrl":"http://rss.cnn.com/rss/cnn_topstories.rss","id":"cnn-top"},
    {"title":"Huffington Post","xmlUrl":"http://feeds.huffingtonpost.com/HP/MostPopular","htmlUrl":"http://www.huffingtonpost.com/","category":"News","defaultOn":true,"altUrl":"https://www.huffpost.com/section/politics/feed","id":"huff-pop"},
    {"title":"Westword - News","xmlUrl":"http://blogs.westword.com/latestword/atom.xml","htmlUrl":"https://www.westword.com/news.rss","category":"News","defaultOn":true,"altUrl":"https://www.westword.com/news.rss","id":"westword"},
    {"title":"The Guardian","xmlUrl":"http://www.guardian.co.uk/rssfeed/0,,1,00.xml","htmlUrl":"https://www.theguardian.com/uk","category":"News","defaultOn":true,"altUrl":"https://www.theguardian.com/us-news/rss","id":"guardian-us"},
    {"title":"Chicagoland","xmlUrl":"http://feeds.chicagotribune.com/chicagotribune/news/local/","htmlUrl":"http://www.chicagotribune.com/news/?track=rss","category":"News","defaultOn":true,"altUrl":"https://www.chicagotribune.com/arcio/rss/category/news/?outputType=xml","id":"chi-land"},
    {"title":"The New York Times","xmlUrl":"http://www.nytimes.com/services/xml/rss/nyt/HomePage.xml","htmlUrl":"https://nytimes.com","category":"News","defaultOn":true,"altUrl":"https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml","id":"nyt-home"},
    {"title":"Latest news, sports, weather from Denver and Colorado | The Denver Post","xmlUrl":"http://feeds.denverpost.com/dp-news-breaking-local","htmlUrl":"https://www.denverpost.com","category":"News","defaultOn":true,"altUrl":"https://www.denverpost.com/feed/","id":"denver-post"},
    {"title":"Associated Press","xmlUrl":"http://customwire.ap.org/lineups/LATESTPOLITICS.rss?SITE=AP","htmlUrl":"http://hosted.ap.org/","category":"News","defaultOn":true,"altUrl":"https://rsshub.app/apnews/topics/politics","id":"ap-politics"},
    {"title":"English - VICE","xmlUrl":"http://www.vice.com/rss","htmlUrl":"https://www.vice.com/en/","category":"News","defaultOn":true,"altUrl":"https://www.vice.com/en/rss","id":"vice-en"},
    {"title":"Business Insider","xmlUrl":"http://feeds2.feedburner.com/businessinsider","htmlUrl":"https://www.businessinsider.com","category":"News","defaultOn":true,"altUrl":"https://www.businessinsider.com/rss","id":"biz-insider"},
    {"title":"Psychology Headlines Around the World","xmlUrl":"http://www.socialpsychology.org/headlines.rss","htmlUrl":"http://www.socialpsychology.org/","category":"News","defaultOn":true,"altUrl":"https://www.socialpsychology.org/headlines.rss","id":"psych-head"},
    {"title":"Gothamist","xmlUrl":"http://gothamist.com/index.rdf","htmlUrl":"https://gothamist.com","category":"News","defaultOn":true,"altUrl":"https://gothamist.com/feed","id":"gothamist"},
    {"title":"Fareed Zakaria: GPS","xmlUrl":"http://globalpublicsquare.blogs.cnn.com/feed","htmlUrl":"https://globalpublicsquare.blogs.cnn.com","category":"News","defaultOn":true,"altUrl":"https://www.cnn.com/services/rss/","id":"fareed-gps"},
    {"title":"The Atlantic","xmlUrl":"http://feeds.feedburner.com/TheAtlantic","htmlUrl":"https://www.theatlantic.com/","category":"Politics","defaultOn":true,"altUrl":"https://www.theatlantic.com/feed/all/","id":"atlantic"},
    {"title":"Think Progress","xmlUrl":"http://think-progress.tumblr.com/rss","htmlUrl":"https://think-progress.tumblr.com/","category":"Politics","defaultOn":true,"altUrl":"https://thinkprogress.org/feed/","id":"think-prog"},
    {"title":"Mother Jones","xmlUrl":"http://feeds.feedburner.com/motherjones/Politics","htmlUrl":"http://www.motherjones.com/politics/feed","category":"Politics","defaultOn":true,"altUrl":"https://www.motherjones.com/feed/","id":"motherjones"},
    {"title":"Politics","xmlUrl":"http://www.huffingtonpost.com/feeds/verticals/politics/index.xml","htmlUrl":"https://www.huffpost.com/news/politics","category":"Politics","defaultOn":true,"altUrl":"https://www.huffpost.com/section/politics/feed","id":"huff-pol"},
    {"title":"Politico","xmlUrl":"http://feeds.politico.com/politico/rss/politicopicks","htmlUrl":"https://www.politico.com/","category":"Politics","defaultOn":true,"altUrl":"https://rss.politico.com/politics-news.xml","id":"politico"},
    {"title":"The Hill","xmlUrl":"http://thehill.com/component/rss-syndicator/?feed_id=2","htmlUrl":"https://thehill.com","category":"Politics","defaultOn":true,"altUrl":"https://thehill.com/news/feed/","id":"the-hill"},
    {"title":"Politifact","xmlUrl":"http://www.politifact.com/feeds/statements/truth-o-meter/","htmlUrl":"http://www.politifact.com/truth-o-meter/","category":"Politics","defaultOn":true,"altUrl":"https://www.politifact.com/rss/statements/truth-o-meter/","id":"politifact"},
    {"title":"Jacobin","xmlUrl":"http://jacobinmag.com/feed/","htmlUrl":"https://jacobin.com","category":"Politics","defaultOn":true,"altUrl":"https://jacobin.com/feed/","id":"jacobin"},
    {"title":"ThinkProgress","xmlUrl":"http://feeds.feedburner.com/climateprogress/lCrX","htmlUrl":"https://thinkprogress.org/tagged/romm?source=rss----e5293acf313e--romm","category":"Politics","defaultOn":true,"altUrl":"https://thinkprogress.org/feed/","id":"think-clim"},
    {"title":"Slate","xmlUrl":"http://feeds.slate.com/slate-101526","htmlUrl":"https://slate.com/","category":"Politics","defaultOn":true,"altUrl":"https://slate.com/feeds/all.rss","id":"slate"},
    {"title":"The Independent","xmlUrl":"http://www.independent.co.uk/rss","htmlUrl":"https://www.independent.co.uk/rss","category":"Politics","defaultOn":true,"altUrl":"https://www.independent.co.uk/news/rss","id":"indep"},
    {"title":"Washington Post | Politics","xmlUrl":"http://www.washingtonpost.com/wp-dyn/rss/politics/index.xml","htmlUrl":"https://www.washingtonpost.com","category":"Politics","defaultOn":true,"altUrl":"https://feeds.washingtonpost.com/rss/politics","id":"wapo-pol"},
    {"title":"NBC News Politics","xmlUrl":"http://rss.msnbc.msn.com/id/3032552/device/rss/rss.xml","htmlUrl":"https://www.nbcnews.com/","category":"Politics","defaultOn":true,"altUrl":"https://feeds.nbcnews.com/nbcnews/public/politics","id":"nbc-pol"},
    {"title":"The Intercept","xmlUrl":"https://firstlook.org/theintercept/feed/","htmlUrl":"https://theintercept.com/","category":"Politics","defaultOn":true,"altUrl":"https://theintercept.com/feed/","id":"intercept"},
    {"title":"Talking Points Memo","xmlUrl":"http://talkingpointsmemo.com/feed/newscred","htmlUrl":"https://talkingpointsmemo.com","category":"Politics","defaultOn":true,"altUrl":"https://talkingpointsmemo.com/feed","id":"tpm"},
    /* Additional civic / progressive news desks — not in the original
     * Feedly export, but they match the Politics/News workflow. */
    {"title":"ProPublica","xmlUrl":"https://www.propublica.org/feeds/propublica/main","htmlUrl":"https://www.propublica.org/","category":"Politics","defaultOn":true,"altUrl":"https://www.propublica.org/feeds/propublica/main","id":"propublica"},
    {"title":"Democracy Now!","xmlUrl":"https://www.democracynow.org/democracynow.rss","htmlUrl":"https://www.democracynow.org/","category":"Politics","defaultOn":true,"altUrl":"https://www.democracynow.org/democracynow.rss","id":"demnow"},
    {"title":"The Nation","xmlUrl":"https://www.thenation.com/feed/?post_type=article","htmlUrl":"https://www.thenation.com/","category":"Politics","defaultOn":true,"altUrl":"https://www.thenation.com/feed/?post_type=article","id":"thenation"},
    {"title":"Common Dreams","xmlUrl":"https://www.commondreams.org/rss.xml","htmlUrl":"https://www.commondreams.org/","category":"Politics","defaultOn":true,"altUrl":"https://www.commondreams.org/rss.xml","id":"commondreams"},
    {"title":"Current Affairs","xmlUrl":"https://www.currentaffairs.org/feed","htmlUrl":"https://www.currentaffairs.org/","category":"Politics","defaultOn":true,"altUrl":"https://www.currentaffairs.org/feed","id":"curaffairs"},
    {"title":"In These Times","xmlUrl":"https://inthesetimes.com/feed/","htmlUrl":"https://inthesetimes.com/","category":"Politics","defaultOn":true,"altUrl":"https://inthesetimes.com/feed/","id":"inthesetimes"},
    {"title":"Truthout","xmlUrl":"https://truthout.org/feed/","htmlUrl":"https://truthout.org/","category":"Politics","defaultOn":true,"altUrl":"https://truthout.org/feed/","id":"truthout"},
    {"title":"NPR Politics","xmlUrl":"https://feeds.npr.org/1014/rss.xml","htmlUrl":"https://www.npr.org/sections/politics/","category":"Politics","defaultOn":true,"altUrl":"https://feeds.npr.org/1014/rss.xml","id":"npr-pol"},
    {"title":"Axios","xmlUrl":"https://api.axios.com/feed/","htmlUrl":"https://www.axios.com/","category":"News","defaultOn":true,"altUrl":"https://api.axios.com/feed/","id":"axios"},
    {"title":"AP News","xmlUrl":"https://rsshub.app/apnews/topics/apf-topnews","htmlUrl":"https://apnews.com/","category":"News","defaultOn":true,"altUrl":"https://rsshub.app/apnews/topics/apf-topnews","id":"ap-top"},
    {"title":"The 19th","xmlUrl":"https://19thnews.org/feed/","htmlUrl":"https://19thnews.org/","category":"Politics","defaultOn":true,"altUrl":"https://19thnews.org/feed/","id":"the19th"},
    {"title":"Bolts","xmlUrl":"https://boltsmag.org/feed/","htmlUrl":"https://boltsmag.org/","category":"Politics","defaultOn":true,"altUrl":"https://boltsmag.org/feed/","id":"bolts"},
    {"title":"Labor Notes","xmlUrl":"https://labornotes.org/feed","htmlUrl":"https://labornotes.org/","category":"Politics","defaultOn":true,"altUrl":"https://labornotes.org/feed","id":"labornotes"},
    {"title":"NYT Politics","xmlUrl":"https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml","htmlUrl":"https://www.nytimes.com/section/politics","category":"Politics","defaultOn":true,"altUrl":"https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml","id":"nyt-pol"},
    {"title":"BBC US & Canada","xmlUrl":"https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml","htmlUrl":"https://www.bbc.com/news/world/us_and_canada","category":"News","defaultOn":true,"altUrl":"https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml","id":"bbc-us"},
    /* Progressive-sphere desks — investigative, labor, democracy, local
     * progressive outlets that match civic destination ranking. */
    {"title":"The Lever","xmlUrl":"https://www.levernews.com/rss/","htmlUrl":"https://www.levernews.com/","category":"Politics","defaultOn":true,"altUrl":"https://www.levernews.com/rss/","id":"the-lever"},
    {"title":"The New Republic","xmlUrl":"https://newrepublic.com/rss.xml","htmlUrl":"https://newrepublic.com/","category":"Politics","defaultOn":true,"altUrl":"https://newrepublic.com/rss.xml","id":"new-republic"},
    {"title":"The American Prospect","xmlUrl":"https://americanprospect.org/feed/","htmlUrl":"https://prospect.org/","category":"Politics","defaultOn":true,"altUrl":"https://americanprospect.org/feed/","id":"am-prospect"},
    {"title":"Capital B","xmlUrl":"https://capitalbnews.org/feed/","htmlUrl":"https://capitalbnews.org/","category":"Politics","defaultOn":true,"altUrl":"https://capitalbnews.org/feed/","id":"capital-b"},
    {"title":"Texas Tribune","xmlUrl":"https://www.texastribune.org/feeds/latest/","htmlUrl":"https://www.texastribune.org/","category":"News","defaultOn":true,"altUrl":"https://www.texastribune.org/feeds/latest/","id":"texas-trib"},
    {"title":"Wisconsin Examiner","xmlUrl":"https://wisconsinexaminer.com/feed/","htmlUrl":"https://wisconsinexaminer.com/","category":"Politics","defaultOn":true,"altUrl":"https://wisconsinexaminer.com/feed/","id":"wisc-exam"},
    {"title":"Michigan Advance","xmlUrl":"https://michiganadvance.com/feed/","htmlUrl":"https://michiganadvance.com/","category":"Politics","defaultOn":true,"altUrl":"https://michiganadvance.com/feed/","id":"mich-adv"},
    {"title":"The Appeal","xmlUrl":"https://www.theappeal.org/feed/","htmlUrl":"https://www.theappeal.org/","category":"Politics","defaultOn":true,"altUrl":"https://www.theappeal.org/feed/","id":"the-appeal"},
    {"title":"Prism","xmlUrl":"https://prismreports.org/feed/","htmlUrl":"https://prismreports.org/","category":"Politics","defaultOn":true,"altUrl":"https://prismreports.org/feed/","id":"prism-rpt"},
    {"title":"Reveal","xmlUrl":"https://revealnews.org/feed/","htmlUrl":"https://revealnews.org/","category":"Politics","defaultOn":true,"altUrl":"https://revealnews.org/feed/","id":"reveal-news"},
    {"title":"Jewish Currents","xmlUrl":"https://jewishcurrents.org/feed/","htmlUrl":"https://jewishcurrents.org/","category":"Politics","defaultOn":true,"altUrl":"https://jewishcurrents.org/feed/","id":"jewish-curr"},
    {"title":"Washington Monthly","xmlUrl":"https://washingtonmonthly.com/feed/","htmlUrl":"https://washingtonmonthly.com/","category":"Politics","defaultOn":true,"altUrl":"https://washingtonmonthly.com/feed/","id":"wash-month"},
    {"title":"Rewire News Group","xmlUrl":"https://rewirenewsgroup.com/feed/","htmlUrl":"https://rewirenewsgroup.com/","category":"Politics","defaultOn":true,"altUrl":"https://rewirenewsgroup.com/feed/","id":"rewire-ng"},
    {"title":"Documented","xmlUrl":"https://documentedny.com/feed/","htmlUrl":"https://documentedny.com/","category":"Politics","defaultOn":true,"altUrl":"https://documentedny.com/feed/","id":"documented"},
    {"title":"STAT","xmlUrl":"https://www.statnews.com/feed/","htmlUrl":"https://www.statnews.com/","category":"News","defaultOn":true,"altUrl":"https://www.statnews.com/feed/","id":"stat-news"},
    {"title":"The Markup","xmlUrl":"https://themarkup.org/feeds/rss.xml","htmlUrl":"https://themarkup.org/","category":"News","defaultOn":true,"altUrl":"https://themarkup.org/feeds/rss.xml","id":"the-markup"},
    {"title":"Center for Public Integrity","xmlUrl":"https://publicintegrity.org/feed/","htmlUrl":"https://publicintegrity.org/","category":"Politics","defaultOn":true,"altUrl":"https://publicintegrity.org/feed/","id":"pub-integ"},
    {"title":"Drop Site News","xmlUrl":"https://www.dropsitenews.com/feed","htmlUrl":"https://www.dropsitenews.com/","category":"Politics","defaultOn":true,"altUrl":"https://www.dropsitenews.com/feed","id":"drop-site"},
    {"title":"Zeteo","xmlUrl":"https://zeteo.com/feed","htmlUrl":"https://zeteo.com/","category":"Politics","defaultOn":true,"altUrl":"https://zeteo.com/feed","id":"zeteo"},
    {"title":"More Perfect Union","xmlUrl":"https://www.moreperfectunion.org/feed","htmlUrl":"https://www.moreperfectunion.org/","category":"Politics","defaultOn":true,"altUrl":"https://www.moreperfectunion.org/feed","id":"more-perf"},
    {"title":"Heated","xmlUrl":"https://heated.world/feed","htmlUrl":"https://heated.world/","category":"Politics","defaultOn":true,"altUrl":"https://heated.world/feed","id":"heated"},
    {"title":"Salon","xmlUrl":"https://www.salon.com/feed/","htmlUrl":"https://www.salon.com/","category":"Politics","defaultOn":true,"altUrl":"https://www.salon.com/feed/","id":"salon"},
    {"title":"Raw Story","xmlUrl":"https://www.rawstory.com/feeds/feed.rss","htmlUrl":"https://www.rawstory.com/","category":"Politics","defaultOn":true,"altUrl":"https://www.rawstory.com/feeds/feed.rss","id":"raw-story"}
  ];

  /* Folders the OPML carried that we refuse to load even on re-import.
   * Sports and culture podcasts are not what discovery is for. */
  const SKIP_FOLDERS = new Set([
    "yankees", "giants", "listen subscriptions", "sports", "entertainment",
    "pop", "music", "movies", "tv", "comics",
  ]);
  const SKIP_FEED_TITLES = new Set([
    "xkcd", "tedtalks (video)", "sherman ave", "a little prioccupied",
    "the blog", "gq", "chicagoist", "northwestern business review",
    "npr: culturetopia podcast",
  ]);

  /* ------------------------------------------------------------------
   * STATE
   * ------------------------------------------------------------------ */

  let store = loadStore();
  let articles = []; /* strength-sorted in the view; pull keeps newest-first */
  let matchCache = {}; /* article id -> match result */
  let pulling = false;
  let persistHeadlinesTimer = null;
  let restoredFromCache = false;

  function loadStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (raw && typeof raw === "object") return raw;
    } catch (_) {}
    return {
      enabledCategories: { Politics: true, News: true, Tech: false },
      customFeeds: [], /* from OPML import, same shape as CATALOG */
      disabledFeedIds: [],
    };
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }
    catch (_) {}
  }

  function demoActive() {
    return !!(window.Demo && Demo.isActive && Demo.isActive());
  }

  /* Compact match rows so a refresh can restore destination chips / sort
   * without re-running Discovery for every headline immediately. */
  function serializeMatch(m) {
    if (!m) return null;
    function packPosted(ap) {
      if (!ap) return null;
      const post = ap.post || null;
      return {
        source: ap.source || "archive",
        post: post ? {
          id: post.id || "",
          permalink: post.permalink || "",
          score: post.score,
          created_utc: post.created_utc,
          title: post.title || "",
        } : null,
      };
    }
    return {
      candidates: (m.candidates || []).slice(0, 8).map((c) => ({
        name: c.name || c.key,
        key: c.key || c.name,
        score: c.score,
        blocked: !!c.blocked,
        alreadyPosted: packPosted(c.alreadyPosted),
      })),
      blocked: (m.blocked || []).slice(0, 6).map((c) => ({
        name: c.name || c.key,
        key: c.key || c.name,
        score: c.score,
        blocked: true,
        alreadyPosted: packPosted(c.alreadyPosted),
      })),
      spheres: (m.spheres || []).slice(0, 4).map((s) => ({
        key: s.key,
        label: s.label,
        confidence: s.confidence,
      })),
      keywords: (m.keywords || m.terms || []).slice(0, 10),
      archiveChecked: !!m.archiveChecked,
    };
  }

  function persistHeadlinesNow() {
    if (demoActive()) return;
    try {
      const matches = {};
      for (const a of articles) {
        if (!a || !a.id) continue;
        const packed = serializeMatch(matchCache[a.id]);
        if (packed) matches[a.id] = packed;
      }
      store.headlineCache = {
        savedAt: Date.now(),
        matchRev: MATCH_CACHE_REV,
        articles: articles.map((a) => ({
          id: a.id,
          title: a.title,
          link: a.link,
          url_canonical: a.url_canonical,
          summary: a.summary,
          body: a.body,
          published: a.published,
          image: a.image,
          source: a.source,
          feedId: a.feedId,
          category: a.category,
        })),
        matches: matches,
      };
      persist();
    } catch (err) {
      console.warn("[syndicate] could not cache headlines:", err && err.message);
    }
  }

  function persistHeadlinesSoon() {
    if (persistHeadlinesTimer) clearTimeout(persistHeadlinesTimer);
    persistHeadlinesTimer = setTimeout(() => {
      persistHeadlinesTimer = null;
      persistHeadlinesNow();
    }, 400);
  }

  function hydrateHeadlines() {
    if (demoActive()) return;
    const cache = store.headlineCache;
    if (!cache || !Array.isArray(cache.articles) || !cache.articles.length) return;
    if (!cache.savedAt || (Date.now() - Number(cache.savedAt)) > ARTICLE_TTL_MS) {
      delete store.headlineCache;
      persist();
      return;
    }
    articles = cache.articles.filter((a) => a && a.id && (a.title || a.link));
    matchCache = {};
    /* Older builds sorted the suggest queue by destination strength, so
     * unmatched progressive headlines never entered the cap window and
     * weak Fox-tier tips got frozen in the 24h cache. Drop destination
     * tips from those revisions; keep the headlines. */
    const matchesOk = Number(cache.matchRev) === MATCH_CACHE_REV;
    const matches = matchesOk && cache.matches && typeof cache.matches === "object"
      ? cache.matches
      : {};
    for (const a of articles) {
      const packed = matches[a.id];
      if (!packed) continue;
      matchCache[a.id] = Object.assign({ articleId: a.id, fromCache: true }, packed, {
        candidates: Array.isArray(packed.candidates) ? packed.candidates : [],
        blocked: Array.isArray(packed.blocked) ? packed.blocked : [],
      });
    }
    restoredFromCache = articles.length > 0;
    if (!matchesOk && articles.length) persistHeadlinesNow();
  }

  hydrateHeadlines();

  Syndicate.restoredFromCache = function () { return restoredFromCache; };
  Syndicate.cacheSavedAt = function () {
    const t = store.headlineCache && store.headlineCache.savedAt;
    return t ? Number(t) : 0;
  };

  Syndicate.catalog = function () {
    const custom = Array.isArray(store.customFeeds) ? store.customFeeds : [];
    /* Custom feeds win on id collision so a re-import can refresh URLs. */
    const byId = new Map();
    for (const f of CATALOG) byId.set(f.id, Object.assign({}, f));
    for (const f of custom) if (f && f.id) byId.set(f.id, Object.assign({}, f));
    return Array.from(byId.values());
  };

  Syndicate.categories = function () {
    const set = new Set(Syndicate.catalog().map((f) => f.category || "Other"));
    /* Stable order: Politics, News, then the rest. */
    const preferred = ["Politics", "News", "Tech"];
    const rest = Array.from(set).filter((c) => preferred.indexOf(c) < 0).sort();
    return preferred.filter((c) => set.has(c)).concat(rest);
  };

  Syndicate.isCategoryOn = function (cat) {
    if (store.enabledCategories && typeof store.enabledCategories[cat] === "boolean") {
      return store.enabledCategories[cat];
    }
    return cat === "Politics" || cat === "News";
  };

  Syndicate.setCategory = function (cat, on) {
    store.enabledCategories = store.enabledCategories || {};
    store.enabledCategories[cat] = !!on;
    persist();
  };

  Syndicate.enabledFeeds = function () {
    const disabled = new Set(store.disabledFeedIds || []);
    return Syndicate.catalog().filter((f) => {
      if (disabled.has(f.id)) return false;
      return Syndicate.isCategoryOn(f.category);
    });
  };

  Syndicate.articles = function () { return articles.slice(); };
  Syndicate.pulling = function () { return pulling; };
  Syndicate.matchOf = function (id) { return matchCache[id] || null; };

  /* Highest-rated headlines for the Plan carousel. Prefer destinations
   * that are still clear to post; already-on-sub tips stay visible but
   * rank lower so fresh rooms surface first. */
  Syndicate.destinationScore = function (id) {
    const tips = Syndicate.suggestionsOf(id, 4);
    if (!tips.length) {
      if (matchCache[id]) return -1;
      return -2;
    }
    const clear = tips.find((c) => !c.alreadyPosted) || tips[0];
    let s = clear.score == null ? 0 : Number(clear.score);
    if (clear.alreadyPosted) s -= 80;
    return s;
  };

  Syndicate.topPicks = function (limit) {
    const cap = limit == null ? 12 : limit;
    return articles
      .filter((a) => Syndicate.hasStrongDestination && Syndicate.hasStrongDestination(a.id))
      .slice()
      .sort((a, b) => {
        const db = Syndicate.destinationScore(b.id);
        const da = Syndicate.destinationScore(a.id);
        if (db !== da) return db - da;
        return (b.published || 0) - (a.published || 0);
      })
      .slice(0, cap);
  };

  Syndicate.sources = function () {
    const counts = new Map();
    for (const a of articles) {
      const src = String(a.source || "").trim();
      if (!src) continue;
      counts.set(src, (counts.get(src) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name: name, count: count }));
  };

  /* Top communities for a matched article. Already-posted rooms stay in
   * the list (faded in the UI) so you can see the link exists on that
   * specific sub — they sort after clear destinations. */
  Syndicate.MIN_SUGGEST_SCORE = 35;

  Syndicate.suggestionsOf = function (id, limit) {
    const m = matchCache[id];
    if (!m) return [];
    const floor = (window.Discovery && Discovery.MIN_SUGGEST_SCORE != null)
      ? Discovery.MIN_SUGGEST_SCORE
      : Syndicate.MIN_SUGGEST_SCORE;
    const byName = new Map();
    function consider(c) {
      if (!c) return;
      const score = c.score == null ? 0 : Number(c.score);
      if (score < floor && !c.alreadyPosted) return;
      /* Already-posted tips keep a slightly softer floor so a known hit
       * on r/politics still surfaces even if the offline score was thin. */
      if (c.alreadyPosted && score < Math.min(floor, 20)) return;
      const name = String(c.name || c.key || "").toLowerCase();
      if (!name) return;
      const prev = byName.get(name);
      if (!prev || score > (prev.score || 0) || (c.alreadyPosted && !prev.alreadyPosted)) {
        byName.set(name, c);
      }
    }
    for (const c of m.candidates || []) consider(c);
    /* Legacy caches parked dupes under blocked — still surface them. */
    for (const c of m.blocked || []) {
      if (c && c.alreadyPosted) consider(c);
    }
    const strong = Array.from(byName.values()).sort((a, b) => {
      const ap = a.alreadyPosted ? 1 : 0;
      const bp = b.alreadyPosted ? 1 : 0;
      if (ap !== bp) return ap - bp;
      return (b.score || 0) - (a.score || 0);
    });
    if (!strong.length) return [];
    const cap = limit == null ? 3 : limit;
    const clear = strong.filter((c) => !c.alreadyPosted);
    if (clear.length >= 2 && cap > 1) {
      const top = clear[0].score || 0;
      const second = clear[1].score || 0;
      if (top - second >= 12) {
        const posted = strong.filter((c) => c.alreadyPosted).slice(0, Math.max(0, cap - 1));
        return [clear[0]].concat(posted).slice(0, cap);
      }
    }
    return strong.slice(0, cap);
  };

  Syndicate.clearMatches = function () {
    matchCache = {};
    persistHeadlinesSoon();
  };

  /* ------------------------------------------------------------------
   * OPML
   * ------------------------------------------------------------------ */

  Syndicate.parseOpml = function (text) {
    const doc = new DOMParser().parseFromString(String(text || ""), "text/xml");
    if (doc.querySelector("parsererror")) throw new Error("That file is not readable OPML.");
    const out = [];
    const body = doc.querySelector("body") || doc.documentElement;

    function walk(node, folder) {
      if (!node || node.nodeType !== 1) return;
      const tag = (node.tagName || "").toLowerCase();
      if (tag !== "outline") {
        for (const child of node.children || []) walk(child, folder);
        return;
      }
      const xmlUrl = node.getAttribute("xmlUrl") || node.getAttribute("xmlurl");
      const title = node.getAttribute("title") || node.getAttribute("text") || "";
      const type = (node.getAttribute("type") || "").toLowerCase();
      if (xmlUrl || type === "rss") {
        const folderKey = String(folder || "Other").toLowerCase();
        if (SKIP_FOLDERS.has(folderKey)) return;
        if (SKIP_FEED_TITLES.has(String(title).toLowerCase())) return;
        out.push({
          id: hashId(xmlUrl || title),
          title: title || xmlUrl,
          xmlUrl: xmlUrl,
          htmlUrl: node.getAttribute("htmlUrl") || node.getAttribute("htmlurl") || "",
          category: folder || "Other",
          defaultOn: folder === "Politics" || folder === "News",
        });
        return;
      }
      const nextFolder = title || folder;
      for (const child of node.children || []) walk(child, nextFolder);
    }

    for (const child of body.children || []) walk(child, null);
    return out;
  };

  Syndicate.importOpml = function (text) {
    const parsed = Syndicate.parseOpml(text);
    if (!parsed.length) throw new Error("No Politics or News feeds found in that OPML.");
    store.customFeeds = parsed;
    /* Turn on every category that arrived, except Tech stays off unless
     * the user flips it — same default as the shipped catalog. */
    store.enabledCategories = store.enabledCategories || {};
    for (const f of parsed) {
      if (f.category === "Tech") {
        if (store.enabledCategories.Tech == null) store.enabledCategories.Tech = false;
      } else {
        store.enabledCategories[f.category] = true;
      }
    }
    persist();
    return parsed;
  };

  function hashId(s) {
    let h = 2166136261;
    const str = String(s || "");
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ("0000000000" + (h >>> 0).toString(16)).slice(-10);
  }

  /* ------------------------------------------------------------------
   * FETCH + PARSE
   * ------------------------------------------------------------------ */

  function stripHtml(html) {
    if (!html) return "";
    const tmp = document.createElement("div");
    tmp.innerHTML = String(html);
    return (tmp.textContent || tmp.innerText || "").replace(/\s+/g, " ").trim();
  }

  function textOf(el) {
    if (!el) return "";
    /* Prefer textContent; CDATA lands there. Some feeds put HTML in
     * description — strip tags after. */
    return stripHtml(el.textContent || "");
  }

  function first(el, names) {
    if (!el) return null;
    for (const name of names) {
      const hit = el.getElementsByTagName(name)[0]
        || el.getElementsByTagNameNS("*", name.split(":").pop())[0];
      if (hit) return hit;
    }
    return null;
  }

  Syndicate.parseFeedXml = function (xml, meta) {
    meta = meta || {};
    const doc = new DOMParser().parseFromString(String(xml || ""), "text/xml");
    if (doc.querySelector("parsererror")) throw new Error("Feed XML did not parse.");

    const channel = doc.querySelector("channel");
    const feedTitle = textOf(first(channel || doc, ["title"])) || meta.title || "";
    const items = [];

    /* RSS 2.0 */
    const rssItems = doc.querySelectorAll("channel > item, rdf\\:RDF > item, item");
    if (channel || rssItems.length) {
      rssItems.forEach((item, i) => {
        if (i >= PER_FEED) return;
        const title = textOf(first(item, ["title"]));
        const link = textOf(first(item, ["link"])) || attr(item, "link", "href");
        const summary = textOf(first(item, ["description", "summary", "content:encoded", "content"]));
        const content = textOf(first(item, ["content:encoded", "content", "description"]));
        const pub = textOf(first(item, ["pubDate", "published", "updated", "dc:date"]));
        if (!title && !link) return;
        const rawHtml = (first(item, ["content:encoded", "content", "description"]) || {}).innerHTML
          || (first(item, ["description"]) || {}).textContent || "";
        items.push(makeArticle({
          title, link, summary, content, published: pub,
          image: thumbOf(item, rawHtml),
          source: feedTitle || meta.title, feedId: meta.id, category: meta.category,
        }));
      });
      return { title: feedTitle, items };
    }

    /* Atom */
    const entries = doc.querySelectorAll("entry");
    entries.forEach((entry, i) => {
      if (i >= PER_FEED) return;
      const title = textOf(first(entry, ["title"]));
      let link = "";
      const links = entry.getElementsByTagName("link");
      for (const l of links) {
        const rel = (l.getAttribute("rel") || "alternate").toLowerCase();
        if (rel === "alternate" || !link) link = l.getAttribute("href") || "";
        if (rel === "alternate" && link) break;
      }
      const summary = textOf(first(entry, ["summary", "content"]));
      const content = textOf(first(entry, ["content", "summary"]));
      const pub = textOf(first(entry, ["published", "updated"]));
      if (!title && !link) return;
      const rawHtml = (first(entry, ["content", "summary"]) || {}).innerHTML || "";
      items.push(makeArticle({
        title, link, summary, content, published: pub,
        image: thumbOf(entry, rawHtml),
        source: feedTitle || meta.title, feedId: meta.id, category: meta.category,
      }));
    });
    return { title: feedTitle, items };
  };

  function thumbOf(el, rawHtml) {
    if (!el) return "";
    const media = el.getElementsByTagName("thumbnail")[0]
      || el.getElementsByTagNameNS("*", "thumbnail")[0];
    if (media) {
      const u = media.getAttribute("url") || media.getAttribute("href") || textOf(media);
      if (u && /^https?:/i.test(u)) return u;
    }
    const encs = el.getElementsByTagName("enclosure");
    for (const enc of encs) {
      const type = (enc.getAttribute("type") || "").toLowerCase();
      const u = enc.getAttribute("url") || "";
      if (u && (/^image\//.test(type) || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(u))) return u;
    }
    const itunes = el.getElementsByTagNameNS("*", "image")[0]
      || el.getElementsByTagName("image")[0];
    if (itunes) {
      const u = itunes.getAttribute("href") || itunes.getAttribute("url")
        || textOf(first(itunes, ["url"])) || textOf(itunes);
      if (u && /^https?:/i.test(u)) return u;
    }
    const m = String(rawHtml || "").match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m && /^https?:/i.test(m[1])) return m[1];
    return "";
  }

  function attr(el, tag, name) {
    const n = first(el, [tag]);
    return n ? (n.getAttribute(name) || "") : "";
  }

  function cleanText(s) {
    const raw = String(s == null ? "" : s);
    return (Util.decodeEntities ? Util.decodeEntities(raw) : raw).replace(/\s+/g, " ").trim();
  }

  function makeArticle(raw) {
    const link = String(raw.link || "").trim();
    const title = cleanText(raw.title) || "Untitled";
    const body = cleanText(raw.content || raw.summary || "");
    const summary = cleanText(raw.summary || body).slice(0, 600);
    let publishedMs = 0;
    if (raw.published != null && raw.published !== "") {
      if (typeof raw.published === "number") {
        publishedMs = raw.published > 1e12 ? raw.published : raw.published * 1000;
      } else {
        const asNum = Number(raw.published);
        if (Number.isFinite(asNum) && asNum > 1e8) {
          publishedMs = asNum > 1e12 ? asNum : asNum * 1000;
        } else {
          publishedMs = Date.parse(raw.published) || 0;
        }
      }
    }
    const id = hashId((link || title) + "|" + (raw.feedId || ""));
    let urlCanonical = link;
    if (window.Reddit && Reddit.canonicalizeUrl && link) {
      try { urlCanonical = Reddit.canonicalizeUrl(link) || link; } catch (_) {}
    }
    return {
      id: id,
      title: title,
      link: link,
      url_canonical: urlCanonical,
      summary: summary,
      body: body.slice(0, 4000),
      published: publishedMs ? Math.floor(publishedMs / 1000) : 0,
      image: String(raw.image || "").trim(),
      source: cleanText(raw.source) || "",
      feedId: raw.feedId || "",
      category: cleanText(raw.category) || "",
    };
  }

  async function fetchText(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(14000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }

  /* rss2json returns structured items when it works; corsproxy returns
   * raw XML. Either path is enough. */
  Syndicate.fetchFeed = async function (feed) {
    const urls = [];
    if (feed.altUrl) urls.push(feed.altUrl);
    if (feed.xmlUrl && feed.xmlUrl !== feed.altUrl) urls.push(feed.xmlUrl);
    /* Prefer https when the OPML still has http. */
    for (const u of urls.slice()) {
      if (u.indexOf("http://") === 0) urls.push("https://" + u.slice(7));
    }
    const unique = [];
    const seen = new Set();
    for (const u of urls) {
      if (!u || seen.has(u)) continue;
      seen.add(u);
      unique.push(u);
    }

    let lastErr = null;
    for (const target of unique) {
      /* 1. rss2json — JSON, CORS-open, includes description. */
      try {
        const endpoint = "https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(target);
        const raw = await fetchText(endpoint);
        const data = JSON.parse(raw);
        if (data.status === "ok" && Array.isArray(data.items)) {
          const items = data.items.slice(0, PER_FEED).map((it) => makeArticle({
            title: it.title,
            link: it.link || it.guid,
            summary: stripHtml(it.description || ""),
            content: stripHtml(it.content || it.description || ""),
            published: it.pubDate,
            image: it.thumbnail || (it.enclosure && /^image\//.test(it.enclosure.type || "") && it.enclosure.link)
              || "",
            source: (data.feed && data.feed.title) || feed.title,
            feedId: feed.id,
            category: feed.category,
          }));
          return { title: (data.feed && data.feed.title) || feed.title, items, via: "rss2json", url: target };
        }
        lastErr = new Error((data && data.message) || "rss2json failed");
      } catch (err) {
        lastErr = err;
      }

      /* 2. CORS proxy + local XML parse. */
      try {
        const proxied = "https://corsproxy.io/?" + encodeURIComponent(target);
        const xml = await fetchText(proxied);
        if (xml && xml.charAt(0) === "<") {
          const parsed = Syndicate.parseFeedXml(xml, feed);
          parsed.via = "corsproxy";
          parsed.url = target;
          return parsed;
        }
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Could not read feed");
  };

  Syndicate.pull = async function (opts) {
    opts = opts || {};
    if (pulling) return { articles: articles, errors: [] };
    pulling = true;
    const feeds = opts.feeds || Syndicate.enabledFeeds();
    const collected = [];
    const errors = [];
    let done = 0;
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : function () {};

    try {
      await Util.pmap(feeds, FEED_CONCURRENCY, async (feed) => {
        try {
          const res = await Syndicate.fetchFeed(feed);
          for (const item of res.items || []) collected.push(item);
        } catch (err) {
          errors.push({ feed: feed.title, message: (err && err.message) || String(err) });
        } finally {
          done++;
          onProgress(done, feeds.length, feed.title);
        }
      });

      /* Dedupe by link, keep newest. */
      const byKey = new Map();
      for (const a of collected) {
        const key = (a.link || a.id).toLowerCase();
        const prev = byKey.get(key);
        if (!prev || (a.published || 0) > (prev.published || 0)) byKey.set(key, a);
      }
      if (byKey.size) {
        const prevMatches = matchCache;
        articles = Array.from(byKey.values()).sort((a, b) => (b.published || 0) - (a.published || 0));
        /* Keep destination ranks for headlines that survived the pull. */
        const nextMatches = {};
        for (const a of articles) {
          if (prevMatches[a.id]) nextMatches[a.id] = prevMatches[a.id];
        }
        matchCache = nextMatches;
        restoredFromCache = false;
        persistHeadlinesNow();
      }
      /* If every feed failed, keep the cached list so a flaky pull does
       * not wipe the last good headlines. */
      return {
        articles: articles,
        errors: errors,
        feedCount: feeds.length,
        keptCache: !byKey.size && articles.length > 0,
      };
    } finally {
      pulling = false;
    }
  };

  /* ------------------------------------------------------------------
   * KEYWORDS + MATCH
   * ------------------------------------------------------------------ */

  Syndicate.asPost = function (article, opts) {
    opts = opts || {};
    const url = article.link || "";
    let domain = "";
    try { domain = new URL(url).hostname.replace(/^www\./, ""); }
    catch (_) { domain = ""; }
    /* Do not invent a home subreddit from the match list. Stuffing a
     * suggested r/… into `subreddit` made unposted headlines show up in
     * the Posts table as if they had already been submitted there.
     * Pass opts.home only when something is actually known; suggestions
     * go on suggested_sub for Plan copy. */
    let suggested = opts.home || opts.suggested_sub || "";
    if (!suggested && opts.suggestHome !== false) {
      const match = matchCache[article.id];
      const pick = ((match && match.candidates) || []).find((c) => {
        if (!c || c.blocked) return false;
        const rules = c.rules;
        if (!rules || !rules.rule || !rules.rule.allows) return true;
        return rules.rule.allows.indexOf("link") !== -1;
      }) || ((match && match.candidates) || [])[0];
      if (pick) suggested = pick.name || pick.key || "";
    }
    const home = opts.home || "";
    let urlCanonical = article.url_canonical || url;
    if (window.Reddit && Reddit.canonicalizeUrl && url) {
      try { urlCanonical = Reddit.canonicalizeUrl(url) || urlCanonical; } catch (_) {}
    }
    const title = Util.decodeEntities ? Util.decodeEntities(article.title || "") : (article.title || "");
    const source = Util.decodeEntities
      ? Util.decodeEntities(article.source || "")
      : (article.source || "");
    return {
      id: "art_" + article.id,
      title: title,
      selftext: article.body || article.summary || "",
      is_self: false,
      url: url || "https://example.invalid/" + article.id,
      url_canonical: urlCanonical || url,
      domain: domain,
      permalink: url,
      subreddit: home,
      suggested_sub: suggested || "",
      author: source || "[syndicated]",
      source_label: source || "",
      score: 0,
      num_comments: 0,
      created_utc: article.published || Math.floor(Date.now() / 1000),
      over_18: false,
      stickied: false,
      media_provider: "",
      thumbnail: article.image || "",
      imported: true,
      syndicated: true,
    };
  };

  Syndicate.keywords = function (article, limit) {
    const lim = limit || 8;
    if (article && article._kw && article._kw.n >= lim && Array.isArray(article._kw.terms)) {
      return article._kw.terms.slice(0, lim);
    }
    const text = [article && article.title, article && article.summary, article && article.body]
      .filter(Boolean).join("\n");
    let terms;
    if (!window.Discovery || !Discovery.textVector) {
      terms = simpleKeywords(text, lim);
    } else {
      const vector = Discovery.textVector(text);
      const raw = Discovery.topTerms
        ? Discovery.topTerms(vector, lim)
        : Object.keys(vector).sort((a, b) => vector[b] - vector[a]).slice(0, lim);
      terms = raw.map((t) => (typeof t === "string" ? t : (t.term || String(t))));
    }
    if (article) article._kw = { n: lim, terms: terms };
    return terms;
  };

  function simpleKeywords(text, limit) {
    const stop = /^(the|and|for|that|with|from|this|have|will|are|was|were|been|their|about|after|into|over|than|then|what|when|which|while|would|could|should|your|our|its|his|her|who|how|not|but|all|any|can|had|has|him|she|they|them|also|just|more|most|other|some|such|only|own|same|too|very|via|per|says|said|new)$/i;
    const counts = Object.create(null);
    String(text || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).forEach((w) => {
      if (w.length < 4 || stop.test(w)) return;
      counts[w] = (counts[w] || 0) + 1;
    });
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, limit);
  }

  /* Match one article to communities. Uses Discovery.forPost so Rules
   * and sphere ranking stay consistent with Where-next; articles are
   * synthetic link posts, which is what r/politics-shaped rooms want.
   * After the subject match, unique_link rooms are checked against the
   * archive so "already on r/politics" is visible before you submit. */
  Syndicate.match = async function (article, opts) {
    opts = opts || {};
    if (!article) throw new Error("No article.");
    if (matchCache[article.id] && !opts.force) return matchCache[article.id];

    const post = Syndicate.asPost(article);
    const keywords = Syndicate.keywords(article, 10);
    const include = (window.AppState && AppState.knownSubs)
      ? Array.from(AppState.knownSubs)
      : [];

    function pack(related) {
      const candidates = (related && (related.communities || related.candidates)) || [];
      const enriched = candidates.map((c) => {
        const name = c.name || c.key;
        let rules = null;
        if (window.Rules && Rules.evaluate) {
          rules = Rules.evaluate(post, name, {
            posts: (window.AppState && AppState.posts) || [],
          });
        }
        const isDupe = !!(rules && rules.duplicate);
        /* Format/rule rejects stay hard-blocked. Already-posted links stay
         * in the candidate list so the desk can show them faded. */
        const formatBlock = !!(rules && rules.hard && !rules.ok && !isDupe);
        return Object.assign({}, c, {
          rules: rules,
          blocked: formatBlock,
          ruleReasons: (rules && rules.reasons) || [],
          alreadyPosted: isDupe
            ? { post: rules.duplicate, source: "local" }
            : null,
        });
      });
      return {
        articleId: article.id,
        post: post,
        keywords: keywords,
        related: related,
        candidates: enriched.filter((c) => !c.blocked),
        blocked: enriched.filter((c) => c.blocked),
        spheres: (related && related.spheres) || [],
        terms: keywords,
        archiveChecked: false,
      };
    }

    let related = null;
    if (window.Discovery && Discovery.forPost) {
      related = await Discovery.forPost(post, {
        limit: opts.limit || 12,
        include: include,
        live: opts.live !== false && !(window.Demo && Demo.isActive()),
        aboutBudget: opts.aboutBudget,
        liveTimeout: opts.liveTimeout == null ? 8000 : opts.liveTimeout,
        linkPriors: opts.linkPriors,
        onPartial: (partial) => {
          matchCache[article.id] = pack(partial);
          if (typeof opts.onPartial === "function") {
            try { opts.onPartial(matchCache[article.id]); } catch (_) {}
          }
        },
      });
    } else if (window.Discovery && Discovery.run) {
      related = await Discovery.run({
        text: [article.title, article.summary, article.body].join("\n"),
        limit: opts.limit || 12,
        exclude: [],
      });
    } else {
      throw new Error("Discovery is not loaded.");
    }

    let result = pack(related);
    if (opts.skipArchive !== true && window.Rules && Rules.findPostedLink) {
      result = await annotateArchiveDupes(result, post, opts);
    }
    matchCache[article.id] = result;
    persistHeadlinesSoon();
    return result;
  };

  /* Rank many headlines without making the user press Match on each.
   * Offline rank first; archive uniqueness for unique_link rooms is on
   * by default so already-posted destinations can be faded in the UI. */
  let suggesting = false;
  Syndicate.suggesting = function () { return suggesting; };

  /* True when a headline was ranked but has no chip above the floor —
   * these should be eligible for another suggest pass, not frozen. */
  Syndicate.hasStrongDestination = function (id) {
    return Syndicate.suggestionsOf(id, 1).length > 0;
  };

  Syndicate.suggestMany = async function (list, opts) {
    opts = opts || {};
    const refreshWeak = opts.refreshWeak !== false;
    const skipArchive = opts.skipArchive === true;
    const want = (list || []).filter((a) => {
      if (!a || !a.id) return false;
      if (opts.force) return true;
      const cached = matchCache[a.id];
      if (!cached) return true;
      if (!skipArchive && !cached.archiveChecked) return true;
      if (refreshWeak && !Syndicate.hasStrongDestination(a.id)) return true;
      return false;
    });
    if (!want.length) {
      return { done: 0, total: 0, skipped: (list || []).length };
    }
    if (suggesting && !opts.force) {
      return { done: 0, total: want.length, busy: true };
    }
    suggesting = true;
    let done = 0;
    const errors = [];
    try {
      await Util.pmap(want, opts.concurrency || 2, async (article) => {
        try {
          const cached = matchCache[article.id];
          const onlyArchive = cached
            && !opts.force
            && Syndicate.hasStrongDestination(article.id)
            && !cached.archiveChecked
            && !skipArchive;
          if (onlyArchive) {
            await annotateArchiveDupes(cached, Syndicate.asPost(article), {
              archiveCap: opts.archiveCap == null ? 4 : opts.archiveCap,
              signal: opts.signal,
              onPartial: opts.onPartial,
            });
            matchCache[article.id] = cached;
            persistHeadlinesSoon();
          } else {
            await Syndicate.match(article, {
              live: opts.live === true,
              skipArchive: skipArchive,
              archiveCap: opts.archiveCap == null ? 4 : opts.archiveCap,
              limit: opts.limit || 8,
              /* Re-rank weak / empty tips; force also refreshes strong ones. */
              force: !!opts.force || !!(cached && refreshWeak && !Syndicate.hasStrongDestination(article.id)),
              aboutBudget: opts.aboutBudget == null ? 20 : opts.aboutBudget,
              liveTimeout: opts.liveTimeout == null ? 6000 : opts.liveTimeout,
              linkPriors: false,
              onPartial: opts.onPartial,
            });
          }
        } catch (err) {
          errors.push({ id: article.id, message: (err && err.message) || String(err) });
        } finally {
          done++;
          if (typeof opts.onProgress === "function") {
            try { opts.onProgress(done, want.length, article); } catch (_) {}
          }
        }
      });
      return { done: done, total: want.length, errors: errors };
    } finally {
      suggesting = false;
    }
  };

  async function annotateArchiveDupes(result, post, opts) {
    opts = opts || {};
    const pool = [].concat(result.candidates || [], result.blocked || []);
    let need = pool.filter((c) => {
      if (c.alreadyPosted) return false;
      const reqs = c.rules && c.rules.rule && c.rules.rule.requires;
      return reqs && reqs.indexOf("unique_link") !== -1;
    });
    /* Prefer higher-scoring rooms so we learn about the destinations
     * the user is most likely to open first. */
    need = need.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
    const cap = opts.archiveCap == null ? 6 : opts.archiveCap;
    if (cap >= 0) need = need.slice(0, cap);
    if (!need.length) {
      result.archiveChecked = true;
      return result;
    }

    /* Cap concurrent archive queries — unique_link rooms are few. */
    const CONCURRENCY = 3;
    let i = 0;
    async function worker() {
      while (i < need.length) {
        const c = need[i++];
        const name = c.name || c.key;
        try {
          const hit = await Rules.findPostedLink(post, name, {
            posts: (window.AppState && AppState.posts) || [],
            signal: opts.signal,
            limit: 8,
          });
          if (!hit) continue;
          c.alreadyPosted = hit;
          /* Keep in candidates — UI fades these rather than hiding them. */
          c.blocked = false;
          c.rules = Object.assign({}, c.rules || {}, {
            ok: false,
            hard: false,
            duplicate: hit.post,
            reasons: ["already posted on this subreddit"],
          });
          c.ruleReasons = ["already posted on this subreddit"];
        } catch (err) {
          console.warn(`[syndicate] archive dupe r/${name}:`, err && err.message);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, need.length) }, () => worker()));

    const all = pool.slice();
    result.candidates = all.filter((c) => !c.blocked);
    result.blocked = all.filter((c) => c.blocked);
    result.archiveChecked = true;
    if (typeof opts.onPartial === "function") {
      try { opts.onPartial(result); } catch (_) {}
    }
    return result;
  }

  /* ------------------------------------------------------------------
   * DEMO FIXTURES
   * ------------------------------------------------------------------ */

  Syndicate.loadDemo = function () {
    articles = [
      makeArticle({
        title: "Senate bill would expand Medicare to cover dental, vision and hearing",
        link: "https://example.com/demo/medicare-expand",
        summary: "Progressive lawmakers reintroduced a Medicare expansion package covering dental, vision and hearing care, citing polling that shows broad bipartisan support for the benefits.",
        content: "The bill would lower the eligibility age over a decade and add dental, vision and hearing benefits to Medicare. Advocates say single-payer polling remains high. Industry groups oppose the expansion as too costly.",
        published: new Date().toISOString(),
        source: "Demo Wire",
        feedId: "demo-pol",
        category: "Politics",
      }),
      makeArticle({
        title: "Union win: warehouse workers vote to organize at major retailer",
        link: "https://example.com/demo/warehouse-union",
        summary: "Workers at a regional distribution hub voted to join a labor union after a year-long organizing drive focused on scheduling, heat safety and wages.",
        content: "The National Labor Relations Board tallied the votes Tuesday. Organizers credited peer-to-peer conversations and public pressure. The company said it would bargain in good faith.",
        published: new Date(Date.now() - 3600e3).toISOString(),
        source: "Demo Labor Desk",
        feedId: "demo-labor",
        category: "News",
      }),
      makeArticle({
        title: "State court blocks strict voter ID law ahead of midterms",
        link: "https://example.com/demo/voter-id",
        summary: "A judge issued a preliminary injunction against a new voter identification statute, finding likely violations of the state constitution's free-and-equal elections clause.",
        content: "Civil rights groups sued, arguing the law would disenfranchise elderly and low-income voters. The secretary of state said the office would appeal. Election administrators asked for clarity before ballot design deadlines.",
        published: new Date(Date.now() - 7200e3).toISOString(),
        source: "Demo Politics",
        feedId: "demo-vote",
        category: "Politics",
      }),
      makeArticle({
        title: "EPA proposes tougher soot rules for industrial corridors",
        link: "https://example.com/demo/epa-soot",
        summary: "The Environmental Protection Agency proposed tightening fine-particle pollution limits, a move environmental justice groups have sought for years in fenceline communities.",
        content: "The draft rule would revise the annual PM2.5 standard. Industry associations warned of compliance costs. Public health researchers pointed to asthma and heart disease rates near refineries and highways.",
        published: new Date(Date.now() - 10800e3).toISOString(),
        source: "Demo Climate",
        feedId: "demo-env",
        category: "News",
      }),
      makeArticle({
        title: "Investigators detail how a dark-money network funded state races",
        link: "https://example.com/demo/dark-money",
        summary: "A new investigation maps the donors and shell nonprofits behind a wave of state legislative spending, raising fresh questions about disclosure rules.",
        content: "Tax filings and campaign finance records show transfers through a chain of 501(c)(4) groups. Watchdogs called for stronger transparency. Spokespeople for the network said the spending was legal issue advocacy.",
        published: new Date(Date.now() - 14400e3).toISOString(),
        source: "Demo Intercept-style",
        feedId: "demo-money",
        category: "Politics",
      }),
    ];
    matchCache = {};
    return articles;
  };

  /* Drop persisted headlines (Settings reset / tests). */
  Syndicate.clearHeadlineCache = function () {
    articles = [];
    matchCache = {};
    delete store.headlineCache;
    persist();
  };

  /* ------------------------------------------------------------------
   * AUTO PULL — Settings “Syndicate articles”
   * Periodic feed refresh while the tab is open, parallel to live score
   * watching. Default on; headlines still land in the 24h cache.
   * ------------------------------------------------------------------ */

  const AUTO_INTERVAL_MS = 20 * 60 * 1000;
  /* Skip a boot pull when the cache was written this recently — a reload
   * seconds after the last pull should not re-hit every feed. */
  const AUTO_BOOT_FRESH_MS = 15 * 60 * 1000;
  let autoTimer = null;
  let autoVisibilityBound = false;

  Syndicate.autoEnabled = function () {
    return store.autoFetch !== false;
  };

  Syndicate.setAutoEnabled = function (on) {
    store.autoFetch = !!on;
    persist();
    if (on) Syndicate.startAuto();
    else Syndicate.stopAuto();
  };

  Syndicate.autoWatching = function () {
    return !!autoTimer;
  };

  function emitPulled(detail) {
    try {
      document.dispatchEvent(new CustomEvent("syndicate:pulled", { detail: detail || {} }));
    } catch (_) {}
  }

  Syndicate.autoTick = async function (opts) {
    opts = opts || {};
    if (!Syndicate.autoEnabled()) return null;
    if (demoActive()) return null;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
    if (pulling) return null;

    const savedAt = Syndicate.cacheSavedAt() || 0;
    const age = savedAt ? (Date.now() - savedAt) : Infinity;
    if (!opts.force && articles.length && age < AUTO_BOOT_FRESH_MS) {
      emitPulled({ skipped: true, reason: "fresh", articles: articles });
      return { articles: articles, errors: [], skipped: true, keptCache: true };
    }

    try {
      const res = await Syndicate.pull({
        onProgress: typeof opts.onProgress === "function" ? opts.onProgress : undefined,
      });
      emitPulled(Object.assign({ auto: true }, res || {}));
      return res;
    } catch (err) {
      console.warn("[syndicate] auto pull failed:", err && err.message);
      return null;
    }
  };

  Syndicate.startAuto = function () {
    if (!Syndicate.autoEnabled()) return;
    if (autoTimer) return;
    Syndicate.autoTick({ force: false }).catch(() => {});
    autoTimer = setInterval(() => {
      Syndicate.autoTick({ force: true }).catch(() => {});
    }, AUTO_INTERVAL_MS);
    if (!autoVisibilityBound && typeof document !== "undefined") {
      autoVisibilityBound = true;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        if (!Syndicate.autoEnabled() || !autoTimer) return;
        Syndicate.autoTick({ force: false }).catch(() => {});
      });
    }
  };

  Syndicate.stopAuto = function () {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
  };

  window.Syndicate = Syndicate;
})();
