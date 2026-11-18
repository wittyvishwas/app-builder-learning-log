<?php
declare(strict_types=1);

namespace MageMinion\OrderExport\Observer;

use MageMinion\OrderExport\Model\Retry;
use MageMinion\OrderExport\Model\Sender;
use Magento\Framework\Event\Observer;
use Magento\Framework\Event\ObserverInterface;
use Magento\Sales\Model\Order;
use Psr\Log\LoggerInterface;

/**
 * sales_order_place_after: send the order to the ERP. It must never break order placement, so everything is caught.
 */
class ExportOrder implements ObserverInterface
{
    /**
     * @param Sender $sender
     * @param Retry $retry
     * @param LoggerInterface $logger
     */
    public function __construct(
        private readonly Sender $sender,
        private readonly Retry $retry,
        private readonly LoggerInterface $logger
    ) {
    }

    /**
     * Send the placed order to the ERP, or queue it for a retry.
     *
     * @param Observer $observer
     * @return void
     */
    public function execute(Observer $observer): void
    {
        try {
            if (!$this->sender->isEnabled()) {
                return;
            }
            $order = $observer->getEvent()->getOrder();
            $filter = $this->sender->emailFilter();
            if ($filter !== '' && stripos((string)$order->getCustomerEmail(), $filter) === false) {
                return;
            }
            $incrementId = (string)$order->getIncrementId();
            $json = json_encode(
                $this->payload($order, $incrementId),
                JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE
            );
            try {
                $this->sender->post($incrementId, $json);
            } catch (\Throwable $e) {
                $this->retry->add($incrementId, $json, $e->getMessage());
            }
        } catch (\Throwable $e) {
            try {
                $this->logger->error('export failed: ' . $e->getMessage());
            } catch (\Throwable) {
                // Order placement comes first: even a broken log must not stop it.
            }
        }
    }

    /**
     * The JSON body for the ERP.
     *
     * @param Order $order
     * @param string $incrementId
     * @return array
     */
    private function payload(Order $order, string $incrementId): array
    {
        $items = [];
        foreach ($order->getAllItems() as $item) {
            // Children of configurable (and bundle) products repeat the parent's SKU: skip them, as mapper.js does.
            if ($item->getParentItemId() || $item->getParentItem()) {
                continue;
            }
            $items[] = ['sku' => (string)$item->getSku(), 'qty' => (float)$item->getQtyOrdered()];
        }
        $address = $order->getShippingAddress();
        return [
            'orderNumber' => 'module-' . $incrementId,
            'increment_id' => $incrementId,
            'items' => $items,
            'shipping_address' => $address === null ? null : [
                'firstname' => $address->getFirstname(),
                'lastname' => $address->getLastname(),
                'street' => $address->getStreet(),
                'city' => $address->getCity(),
                'postcode' => $address->getPostcode(),
                'region' => $address->getRegion(),
                'country_id' => $address->getCountryId(),
            ],
        ];
    }
}
