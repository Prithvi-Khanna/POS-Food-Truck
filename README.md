Part 1: Architecture & System Design

Scenario
You're tasked with designing a POS system for a food truck chain that operates in areas
with spotty internet connectivity. The system needs to handle order taking, payment
processing, receipt printing, and inventory sync across multiple devices with varying
specifications.


1. Offline-First Architecture
a. For syncing, I'll keep all the orders and stock updates locally in IndexedDB first, then push them to the server when internet is back, while also pulling the latest menu and inventory(Web sockets/Long polling).

b. If two devices change the same record offline, I'll use that specific version and timestamp to resolve. Like the latest update will override the previous changes and in terms of sold items just decrement them.

c. Regular sync of the devices with the server through long polling.

2. Performance Constraints
a. I'll keep the bundle size small by code splitting (using chunks) and lazy loading the data (whenever it is required). 

b. In terms of code wise , i'll implement memoization and virtualised list with proper usage of items props. Also doing the cleanup for the unused code will help in this scenario to free up the RAM.

c. For efficient DOM manipulation it is best to provide keys to our childern or sibling components so that unecessary re-renders of all the components won't happen. Secondly, by placing skeletons or placeholders in the loading states will help us to avoid layout computations again and again.  And for memory management we can use local useState or useReducer(optimal for order status) along with context API for version controlling.

3. Multi-Device Coordination
a. we can create long polling or server sent events which will help us to keep all the deivces and server on the same page.

b. For printers, I’ll keep a shared print queue so each device adds jobs to it and the queue will process them one by one. We can add retry function for the failed jobs so that our data doesn't lose.

c. We can create a LAN for the devices. They can discover each other through mDNS and after that pairing can be done using handshake like QR or PIN. 

4. Data Storage Strategy (15 minutes)
a. IndexedDB is the right choice here since it can handle structured, large datasets and fast queries. LocalStorage is too small, unsecured and limited and doesn’t fit for POS.

b. We'll keep dish IDs and names unique. Searching and filtering can be done over thses keys.

c. For this we can add a utilty check to store the older print jobs and orders to the server and delete from the local IndexDB. Also while fetching the latest version of menu/prices/inventory we can delete the older versions from our local store.